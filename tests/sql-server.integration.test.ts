import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST as upload } from "@/app/api/projects/route";
import { startRun, cancelRun, waitForRunCompletion } from "@/lib/runner";
import { isTerminalRun } from "@/lib/runner/types";
import { closeDatabase } from "@/lib/server/db";
import {
  connectionConfig,
  getConnectionSettings,
  saveConnection,
} from "@/lib/server/connection";
import { getRun } from "@/lib/server/runs";
import type { CreateProjectResponse } from "@/lib/server/uploads";

/** Opt-in only: these scripts create/modify objects in the supplied disposable database. */
it.skipIf(process.env.DATAFORGE_SQL_INTEGRATION !== "1")(
  "loads the real Superstore sample into a dedicated SQL Server with 2,000 facts and no rejects",
  async () => {
    const required = (name: string) => {
      const value = process.env[name];
      if (!value)
        throw new Error(
          `Set ${name} for the opt-in SQL Server integration test.`,
        );
      return value;
    };
    const server = required("DATAFORGE_SQL_TEST_SERVER");
    const database = required("DATAFORGE_SQL_TEST_DATABASE");
    const user = required("DATAFORGE_SQL_TEST_USER");
    const password = required("DATAFORGE_SQL_TEST_PASSWORD");
    const stagingFolder = required("DATAFORGE_SQL_TEST_STAGING_FOLDER");
    const directory = await mkdtemp(
      join(tmpdir(), "dataforge-sql-integration-"),
    );
    let runId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    vi.stubEnv("DATAFORGE_DATA_DIR", directory);
    vi.stubEnv("DATAFORGE_SECRET", randomBytes(32).toString("base64"));
    if (process.env.DATAFORGE_SQL_TEST_WRITE_DIR)
      vi.stubEnv(
        "DATAFORGE_STAGING_WRITE_DIR",
        process.env.DATAFORGE_SQL_TEST_WRITE_DIR,
      );
    try {
      saveConnection({
        server,
        port: Number(process.env.DATAFORGE_SQL_TEST_PORT || 1433),
        database,
        user,
        password,
        stagingFolder,
        encrypt: process.env.DATAFORGE_SQL_TEST_ENCRYPT !== "false",
        trustServerCertificate:
          process.env.DATAFORGE_SQL_TEST_TRUST_CERTIFICATE !== "false",
      });
      const form = new FormData();
      form.set("name", "Superstore SQL integration");
      form.set(
        "file",
        new File(
          [
            await readFile(
              join(process.cwd(), "samples", "superstore_sales.csv"),
            ),
          ],
          "superstore_sales.csv",
          { type: "text/csv" },
        ),
      );
      const uploaded = await upload(
        new Request("http://localhost/api/projects", {
          method: "POST",
          body: form,
        }),
      );
      expect(uploaded.status).toBe(201);
      const { project } = (await uploaded.json()) as CreateProjectResponse;
      const run = await startRun(project.id, {
        incremental: false,
        dedupe: true,
        db: database,
      });
      runId = run.id;
      const completed = await Promise.race([
        waitForRunCompletion(run.id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Integration run exceeded its 180-second test deadline.",
                ),
              ),
            180_000,
          );
        }),
      ]);
      expect(
        completed.run.status,
        completed.run.errorMessage ?? "SQL Server load should succeed",
      ).toBe("succeeded");
      expect(completed.run.rowsStaged).toBe(2000);
      expect(completed.run.rowsLoaded).toBe(2000);
      expect(completed.run.rowsRejected).toBe(0);
      expect(completed.steps).toHaveLength(6);
      expect(completed.steps.every((step) => step.status === "succeeded")).toBe(
        true,
      );
      const sql = (await import("mssql")).default;
      const pool = new sql.ConnectionPool(
        connectionConfig(getConnectionSettings(), 30_000),
      );
      pool.on("error", () => {});
      try {
        await pool.connect();
        const actual = await pool
          .request()
          .input("runId", sql.UniqueIdentifier, run.id).query(`
          SELECT COUNT_BIG(*) AS [facts] FROM [dw].[fact_sales];
          SELECT COUNT_BIG(*) AS [rejects] FROM [dw].[reject_rows] WHERE [run_id]=@runId;
        `);
        const records = actual.recordsets as {
          facts?: number;
          rejects?: number;
        }[][];
        expect(Number(records[0][0].facts)).toBe(2000);
        expect(Number(records[1][0].rejects)).toBe(0);
      } finally {
        await pool.close();
      }
    } finally {
      if (timer) clearTimeout(timer);
      const run = runId ? getRun(runId) : undefined;
      if (run && !isTerminalRun(run.status))
        await cancelRun(run.projectId, run.id);
      closeDatabase();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  210_000,
);
