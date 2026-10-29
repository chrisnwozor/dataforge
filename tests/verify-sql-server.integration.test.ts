import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import {
  readSuperstoreOracle,
  superstoreAcceptanceDifferences,
  SUPERSTORE_ACCEPTANCE as expected,
} from "@/lib/verify/superstore";
import { createProjectFromUpload } from "@/lib/server/uploads";
import { saveConnection } from "@/lib/server/connection";
import { startRun, waitForRunCompletion } from "@/lib/runner";
import { startCheckRun, waitForChecks } from "@/lib/server/verification";
import { getVerificationRun } from "@/lib/server/verification-storage";
import { getSemanticModel } from "@/lib/server/semantic";
import { runSemanticQuery } from "@/lib/server/semantic-query";
import { closeQueryPools } from "@/lib/server/query-transport";
import { closeDatabase } from "@/lib/server/db";
import type { SemanticQuery } from "@/lib/semantic/query/types";
/** Explicit opt-in: generated loads create/modify objects in the configured disposable database. */
it.skipIf(process.env.DATAFORGE_VERIFY_INTEGRATION !== "1")(
  "reconciles Superstore's 2003 staged / 2000 loaded rows, fixed money totals and 2024 YoY against SQL Server",
  async () => {
    const file =
      process.env.DATAFORGE_VERIFY_SUPERSTORE_FILE ||
      join(process.cwd(), "samples/superstore_sales.csv");
    const oracle = await readSuperstoreOracle(file),
      differences = superstoreAcceptanceDifferences(oracle);
    if (differences.length)
      throw new Error(
        `The Superstore fixture does not match the requested acceptance dataset. No SQL has been executed.\n${differences.join("\n")}\nSupply the original 2022–2024 acceptance CSV with DATAFORGE_VERIFY_SUPERSTORE_FILE, or investigate the input discrepancy; expected constants were not replaced.`,
      );
    const required = (key: string) => {
      const value = process.env[key];
      if (!value)
        throw new Error(`Set ${key} for this opt-in integration test.`);
      return value;
    };
    const directory = await mkdtemp(
      join(tmpdir(), "dataforge-checks-integration-"),
    );
    let projectId: string | undefined;
    vi.stubEnv("DATAFORGE_DATA_DIR", directory);
    vi.stubEnv("DATAFORGE_AUTH", "off");
    vi.stubEnv("DATAFORGE_SECRET", randomBytes(32).toString("base64"));
    if (process.env.DATAFORGE_SQL_TEST_WRITE_DIR)
      vi.stubEnv(
        "DATAFORGE_STAGING_WRITE_DIR",
        process.env.DATAFORGE_SQL_TEST_WRITE_DIR,
      );
    try {
      saveConnection({
        server: required("DATAFORGE_SQL_TEST_SERVER"),
        port: Number(process.env.DATAFORGE_SQL_TEST_PORT || 1433),
        database: required("DATAFORGE_SQL_TEST_DATABASE"),
        user: required("DATAFORGE_SQL_TEST_USER"),
        password: required("DATAFORGE_SQL_TEST_PASSWORD"),
        stagingFolder: required("DATAFORGE_SQL_TEST_STAGING_FOLDER"),
        encrypt: process.env.DATAFORGE_SQL_TEST_ENCRYPT !== "false",
        trustServerCertificate:
          process.env.DATAFORGE_SQL_TEST_TRUST_CERTIFICATE !== "false",
      });
      const rows = parse(await readFile(file), {
        bom: true,
        skip_empty_lines: true,
      }) as string[][];
      if (rows.length === 2001) rows.push(...rows.slice(1, 4));
      expect(rows.length - 1).toBe(expected.staged);
      const csv =
        rows
          .map((row) =>
            row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","),
          )
          .join("\n") + "\n";
      const body = new FormData();
      body.set("name", "Checks Superstore acceptance");
      body.set(
        "file",
        new File([csv], "superstore_sales.csv", { type: "text/csv" }),
      );
      const uploaded = await createProjectFromUpload(
        new Request("http://localhost/upload", { method: "POST", body }),
      );
      projectId = uploaded.project.id;
      const load = await startRun(projectId, {
        dedupe: true,
        incremental: false,
      });
      const completed = await waitForRunCompletion(load.id);
      expect(completed.run.status, completed.run.errorMessage ?? "").toBe(
        "succeeded",
      );
      expect(completed.run.rowsStaged).toBe(expected.staged);
      expect(completed.run.rowsLoaded).toBe(expected.loaded);
      expect(completed.run.rowsRejected).toBe(expected.rejects);
      const model = await getSemanticModel(projectId),
        sales = model.measures.find((m) => m.name.toLowerCase() === "sales")!,
        profit = model.measures.find((m) => m.name.toLowerCase() === "profit")!,
        category = model.tables
          .flatMap((t) => t.columns.map((c) => ({ table: t, column: c })))
          .find((v) => v.column.name.toLowerCase() === "category")!,
        year = model.tables
          .flatMap((t) => t.columns.map((c) => ({ table: t, column: c })))
          .find((v) => v.column.name.toLowerCase() === "year")!;
      const query = (measures: string[], rows: SemanticQuery["rows"] = []) =>
        runSemanticQuery(
          projectId!,
          {
            measures,
            rows,
            filters: [],
            orderBy: [],
            hideUnknown: true,
            limit: 100,
            cache: "bypass",
          },
          undefined,
          undefined,
          { priority: "checks" },
        );
      const totals = await query([sales.id, profit.id]);
      const columns = totals.columns.filter((c) => c.role === "measure");
      expect(Number(totals.rows[0][columns[0].key])).toBeCloseTo(
        expected.sales,
        2,
      );
      expect(Number(totals.rows[0][columns[1].key])).toBeCloseTo(
        expected.profit,
        2,
      );
      for (const [group, constants] of [
        [category, expected.categories],
        [year, expected.years],
      ] as const) {
        const result = await query(
            [sales.id],
            [{ table: group.table.id, column: group.column.id }],
          ),
          key = result.columns.find((c) => c.role === "attribute")!.key,
          value = result.columns.find((c) => c.role === "measure")!.key;
        for (const [name, amount] of Object.entries(constants)) {
          const row = result.rows.find((r) => String(r[key]) === name);
          expect(Number(row?.[value])).toBeCloseTo(amount, 2);
        }
      }
      const yoy = model.measures.find((m) => /sales.*yoy/i.test(m.name));
      expect(yoy).toBeDefined();
      const yoyResult = await query(
          [yoy!.id],
          [{ table: year.table.id, column: year.column.id }],
        ),
        yearKey = yoyResult.columns.find((c) => c.role === "attribute")!.key,
        yoyKey = yoyResult.columns.find((c) => c.role === "measure")!.key;
      expect(
        Number(
          yoyResult.rows.find((r) => Number(r[yearKey]) === 2024)?.[yoyKey],
        ) * 100,
      ).toBeCloseTo(expected.yoy2024Percent, 2);
      const checks = await startCheckRun(projectId);
      await waitForChecks(projectId);
      const result = getVerificationRun(projectId, checks.id);
      expect(result.status, result.error ?? "").toBe("succeeded");
      expect(
        result.results
          .filter((c) => c.status === "fail")
          .map((c) => `${c.name}: ${c.explanation}`),
      ).toEqual([]);
    } finally {
      if (projectId) await waitForChecks(projectId).catch(() => {});
      await closeQueryPools();
      closeDatabase();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30 * 60_000,
);
