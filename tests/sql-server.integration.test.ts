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
import { getSemanticModel, saveSemanticModel } from "@/lib/server/semantic";
import { runSemanticQuery } from "@/lib/server/semantic-query";
import { closeQueryPools } from "@/lib/server/query-transport";
import { compileQuery } from "@/lib/semantic/query/compile";
import { invalidateSemanticCache } from "@/lib/semantic/query/cache";
import { quoteIdentifier } from "@/lib/sql/helpers";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticTable,
} from "@/lib/semantic/types";

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

        // Use production semantic derivation/compiler/transport, not SQL supplied through an API.
        let semantic = await getSemanticModel(project.id);
        const timestamp = new Date().toISOString();
        const definitions = [
          ["Profit Margin %", "DIVIDE([Profit], [Sales])", "percent"],
          [
            "Avg Order Value",
            "DIVIDE([Sales], [Distinct Order ID])",
            "currency",
          ],
          [
            "Sales % of Total",
            "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[Category])))",
            "percent",
          ],
          [
            "Furniture Sales",
            "CALCULATE([Sales], dim_product[Category] = 'Furniture')",
            "currency",
          ],
          [
            "Sales % of Category",
            "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product])))",
            "percent",
          ],
          [
            "Sales % of Grand Total",
            "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product]), ALL(dim_product[category])))",
            "percent",
          ],
        ] as const;
        const custom: SemanticMeasure[] = definitions.map(
          ([name, expression, format], index) => ({
            id: `integration:performance:${index}`,
            name,
            expression,
            format,
            folder: "Performance investigation",
            description:
              "Integration fixture for the reported cumulative measure sets.",
            isAuto: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
        semantic = await saveSemanticModel(project.id, {
          version: semantic.version,
          measures: [...semantic.measures, ...custom],
          hierarchies: semantic.hierarchies,
        });
        const measure = (name: string) => {
          const found = semantic.measures.find((value) => value.name === name);
          if (!found) throw new Error(`Missing sample measure: ${name}`);
          return found;
        };
        const column = (name: string): [SemanticTable, SemanticColumn] => {
          for (const table of semantic.tables) {
            const found = table.columns.find((value) => value.name === name);
            if (found) return [table, found];
          }
          throw new Error(`Missing sample attribute: ${name}`);
        };
        const qualified = (table: SemanticTable) =>
          `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.sqlName)}`;
        const fact = semantic.tables.find(
          (table) => table.id === semantic.factTableId,
        )!;
        const salesColumn = fact.columns.find(
          (value) => value.name === "Sales",
        )!;
        const ref = ([table, value]: [SemanticTable, SemanticColumn]) => ({
          table: table.id,
          column: value.id,
        });
        const join = (table: SemanticTable, alias: string) => {
          const relationship = semantic.relationships.find(
            (value) => value.toTableId === table.id,
          )!;
          const foreign = fact.columns.find(
            (value) => value.id === relationship.fromColumnId,
          )!;
          const key = table.columns.find(
            (value) => value.id === relationship.toColumnId,
          )!;
          return `JOIN ${qualified(table)} AS ${quoteIdentifier(alias)} ON [f].${quoteIdentifier(foreign.sqlName)} = ${quoteIdentifier(alias)}.${quoteIdentifier(key.sqlName)}`;
        };
        const category = column("Category");
        const byCategory = await runSemanticQuery(project.id, {
          measures: [measure("Sales").id],
          rows: [ref(category)],
          hideUnknown: true,
        });
        const expectedCategory = await pool.request().query<{
          category: string;
          sales: number;
        }>(`
          SELECT [p].${quoteIdentifier(category[1].sqlName)} AS [category], SUM([f].${quoteIdentifier(salesColumn.sqlName)}) AS [sales]
          FROM ${qualified(fact)} AS [f] ${join(category[0], "p")}
          GROUP BY [p].${quoteIdentifier(category[1].sqlName)};
        `);
        const categoryKey = byCategory.columns.find(
          (value) => value.role === "attribute",
        )!.key;
        const salesKey = byCategory.columns.find(
          (value) => value.role === "measure",
        )!.key;
        const totals = new Map(
          expectedCategory.recordset.map((value) => [
            value.category,
            Number(value.sales),
          ]),
        );
        expect(byCategory.rows).toHaveLength(totals.size);
        for (const row of byCategory.rows)
          expect(Number(row[salesKey])).toBeCloseTo(
            totals.get(String(row[categoryKey]))!,
            4,
          );
        const cached = await runSemanticQuery(project.id, {
          measures: [measure("Sales").id],
          rows: [ref(category)],
          hideUnknown: true,
        });
        expect(cached.fromCache).toBe(true);

        // Compare every cumulative measure set against independent fact-table SQL.
        // These calls bypass the result cache but reuse the healthy SQL connection pool.
        const profitColumn = fact.columns.find(
          (value) => value.name === "Profit",
        )!;
        const orderColumn = fact.columns.find(
          (value) => value.name === "Order ID",
        )!;
        const performanceBaseline = await pool.request().query<{
          category: string;
          sales: number;
          margin: number | null;
          average_order: number | null;
          share: number | null;
          furniture_sales: number | null;
        }>(`
          WITH [category_totals] AS (
            SELECT [p].${quoteIdentifier(category[1].sqlName)} AS [category],
              SUM([f].${quoteIdentifier(salesColumn.sqlName)}) AS [sales],
              SUM([f].${quoteIdentifier(profitColumn.sqlName)}) AS [profit],
              COUNT_BIG(DISTINCT [f].${quoteIdentifier(orderColumn.sqlName)}) AS [orders]
            FROM ${qualified(fact)} AS [f] ${join(category[0], "p")}
            GROUP BY [p].${quoteIdentifier(category[1].sqlName)}
          )
          SELECT [category], [sales],
            CAST([profit] AS FLOAT) / NULLIF([sales], 0) AS [margin],
            CAST([sales] AS FLOAT) / NULLIF([orders], 0) AS [average_order],
            CAST([sales] AS FLOAT) / NULLIF(SUM([sales]) OVER (), 0) AS [share],
            SUM(CASE WHEN [category] = N'Furniture' THEN [sales] END) OVER () AS [furniture_sales]
          FROM [category_totals];
        `);
        const expectedMetrics = new Map(
          performanceBaseline.recordset.map((row) => [row.category, row]),
        );
        const cumulativeNames = [
          "Sales",
          ...definitions.slice(0, 4).map(([name]) => name),
        ];
        for (let count = 1; count <= cumulativeNames.length; count++) {
          invalidateSemanticCache(project.id);
          const names = cumulativeNames.slice(0, count);
          const result = await runSemanticQuery(project.id, {
            measures: names.map((name) => measure(name).id),
            rows: [ref(category)],
          });
          expect(result.fromCache).toBe(false);
          expect(result.rowCount).toBe(expectedMetrics.size);
          expect(result.timings).toBeDefined();
          expect(result.timings!.connectMs).toBe(0);
          expect(
            Object.values(result.timings!).every(
              (value) => Number.isFinite(value) && value >= 0,
            ),
          ).toBe(true);
          const attributeKey = result.columns.find(
            (value) => value.role === "attribute",
          )!.key;
          const metricNames = {
            Sales: "sales",
            "Profit Margin %": "margin",
            "Avg Order Value": "average_order",
            "Sales % of Total": "share",
            "Furniture Sales": "furniture_sales",
          } as const;
          for (const row of result.rows) {
            const expected = expectedMetrics.get(String(row[attributeKey]))!;
            for (const value of result.columns.filter(
              (column) => column.role === "measure",
            )) {
              const expectedValue =
                expected[metricNames[value.name as keyof typeof metricNames]];
              if (expectedValue === null) expect(row[value.key]).toBeNull();
              else
                expect(Number(row[value.key])).toBeCloseTo(
                  Number(expectedValue),
                  5,
                );
            }
          }

          // SHOWPLAN_XML reports the optimizer's physical plan without executing it.
          // Check baseline and ratio together: adding a reference cannot add a fact scan.
          if (count <= 2) {
            const compiled = compileQuery(semantic, {
              measures: names.map((name) => measure(name).id),
              rows: [ref(category)],
            });
            // A batch keeps this connection-level diagnostic outside sp_executesql's scope.
            await pool.request().batch("SET SHOWPLAN_XML ON;");
            try {
              const request = pool.request();
              for (const parameter of compiled.params) {
                const value = parameter.value;
                request.input(
                  parameter.name,
                  parameter.name === "__df_limit"
                    ? sql.Int
                    : typeof value === "number"
                      ? sql.Float
                      : typeof value === "boolean"
                        ? sql.Bit
                        : sql.NVarChar(sql.MAX),
                  value,
                );
              }
              const plan = await request.query(compiled.sql);
              const xml = plan.recordset
                .flatMap((row) => Object.values(row))
                .find(
                  (value) =>
                    typeof value === "string" && value.includes("ShowPlanXML"),
                );
              expect(typeof xml).toBe("string");
              const scans = (
                String(xml).match(/<Object\b[^>]*\/>/g) ?? []
              ).filter(
                (object) =>
                  object.includes(`Table="[${fact.sqlName}]"`) &&
                  object.includes(`Schema="[${fact.schema}]"`),
              );
              expect(
                scans,
                `${names.join(" + ")} should have one physical fact access`,
              ).toHaveLength(1);
            } finally {
              await pool.request().batch("SET SHOWPLAN_XML OFF;");
            }
          }
        }

        // The reported Product + Category combination must remain below one
        // second on the warm production path, including Node preparation.
        const product = column("Product");
        const exactSharesBaseline = await pool.request().query<{
          product: string;
          category: string;
          sales: number;
          category_share: number | null;
          grand_share: number | null;
        }>(`
          WITH [product_totals] AS (
            SELECT [p].${quoteIdentifier(product[1].sqlName)} AS [product], [p].${quoteIdentifier(category[1].sqlName)} AS [category], SUM([f].${quoteIdentifier(salesColumn.sqlName)}) AS [sales]
            FROM ${qualified(fact)} AS [f] ${join(product[0], "p")}
            GROUP BY [p].${quoteIdentifier(product[1].sqlName)}, [p].${quoteIdentifier(category[1].sqlName)}
          )
          SELECT [product], [category], [sales], CAST([sales] AS FLOAT) / NULLIF(SUM([sales]) OVER (PARTITION BY [category]), 0) AS [category_share],
            CAST([sales] AS FLOAT) / NULLIF(SUM([sales]) OVER (), 0) AS [grand_share] FROM [product_totals];
        `);
        invalidateSemanticCache(project.id);
        const exactStart = performance.now();
        const exactShares = await runSemanticQuery(project.id, {
          measures: [
            "Sales",
            "Sales % of Category",
            "Sales % of Grand Total",
          ].map((name) => measure(name).id),
          rows: [ref(product), ref(category)],
        });
        expect(performance.now() - exactStart).toBeLessThan(1_000);
        expect(exactShares.timings!.totalMs).toBeLessThan(1_000);
        expect(exactShares.timings!.connectMs).toBe(0);
        expect(exactShares.fromCache).toBe(false);
        expect(exactShares.rowCount).toBe(exactSharesBaseline.recordset.length);
        const keyFor = (name: string) =>
          exactShares.columns.find((column) => column.name === name)!.key;
        for (const row of exactShares.rows) {
          const expected = exactSharesBaseline.recordset.find(
            (value) =>
              value.product === row[keyFor("Product")] &&
              value.category === row[keyFor("Category")],
          )!;
          expect(Number(row[keyFor("Sales")])).toBeCloseTo(
            Number(expected.sales),
            4,
          );
          expect(Number(row[keyFor("Sales % of Category")])).toBeCloseTo(
            Number(expected.category_share),
            7,
          );
          expect(Number(row[keyFor("Sales % of Grand Total")])).toBeCloseTo(
            Number(expected.grand_share),
            7,
          );
        }

        const year = column("Year");
        const date = column("Date");
        const yoy = await runSemanticQuery(project.id, {
          measures: [measure("Sales YoY %").id],
          rows: [ref(year)],
        });
        const baseline = await pool.request().query<{
          year: number;
          yoy: number | null;
        }>(`
          WITH [periods] AS (
            SELECT [d].${quoteIdentifier(year[1].sqlName)} AS [year], MIN([d].${quoteIdentifier(date[1].sqlName)}) AS [first_date], MAX([d].${quoteIdentifier(date[1].sqlName)}) AS [last_date], SUM([f].${quoteIdentifier(salesColumn.sqlName)}) AS [sales]
            FROM ${qualified(fact)} AS [f] ${join(date[0], "d")}
            GROUP BY [d].${quoteIdentifier(year[1].sqlName)}
          )
          SELECT [p].[year], ([p].[sales] - [prior].[sales]) / NULLIF([prior].[sales], 0) AS [yoy]
          FROM [periods] AS [p] OUTER APPLY (
            SELECT SUM([f].${quoteIdentifier(salesColumn.sqlName)}) AS [sales]
            FROM ${qualified(fact)} AS [f] ${join(date[0], "d")}
            WHERE [d].${quoteIdentifier(date[1].sqlName)} BETWEEN DATEADD(YEAR, -1, [p].[first_date]) AND DATEADD(YEAR, -1, [p].[last_date])
          ) AS [prior];
        `);
        const yearKey = yoy.columns.find(
          (value) => value.role === "attribute",
        )!.key;
        const yoyKey = yoy.columns.find(
          (value) => value.role === "measure",
        )!.key;
        for (const row of yoy.rows) {
          const expected = baseline.recordset.find(
            (value) => Number(value.year) === Number(row[yearKey]),
          )!.yoy;
          if (expected === null) expect(row[yoyKey]).toBeNull();
          else expect(Number(row[yoyKey])).toBeCloseTo(Number(expected), 5);
        }

        // A committed temporary Unknown fact exercises the option through separate pinned sessions.
        const factKey = fact.columns.find(
          (value) => value.id === fact.keyColumnId,
        )!;
        const inserted = await pool
          .request()
          .input("sales", sql.Decimal(18, 2), 5).query<{ id: number }>(`
          INSERT INTO ${qualified(fact)} (${quoteIdentifier(salesColumn.sqlName)}) OUTPUT INSERTED.${quoteIdentifier(factKey.sqlName)} AS [id] VALUES (@sales);
        `);
        try {
          invalidateSemanticCache(project.id);
          const region = column("Region");
          const visible = await runSemanticQuery(project.id, {
            measures: [measure("Row Count").id],
            rows: [ref(region)],
            hideUnknown: false,
          });
          const hidden = await runSemanticQuery(project.id, {
            measures: [measure("Row Count").id],
            rows: [ref(region)],
            hideUnknown: true,
          });
          const countKey = visible.columns.find(
            (value) => value.role === "measure",
          )!.key;
          const sum = (rows: typeof visible.rows) =>
            rows.reduce((total, row) => total + Number(row[countKey]), 0);
          expect(sum(visible.rows)).toBe(2001);
          expect(sum(hidden.rows)).toBe(2000);
        } finally {
          await pool
            .request()
            .input("id", sql.Int, inserted.recordset[0].id)
            .query(
              `DELETE FROM ${qualified(fact)} WHERE ${quoteIdentifier(factKey.sqlName)} = @id;`,
            );
          invalidateSemanticCache(project.id);
        }

        const threeDimensions = await runSemanticQuery(project.id, {
          measures: [measure("Sales").id],
          rows: [ref(category), ref(column("Segment")), ref(column("Region"))],
        });
        expect(threeDimensions.rowCount).toBeGreaterThan(0);
        expect(threeDimensions.fromCache).toBe(false);
        expect(threeDimensions.elapsedMs).toBeLessThan(2_000);
      } finally {
        await pool.close();
      }
    } finally {
      if (timer) clearTimeout(timer);
      const run = runId ? getRun(runId) : undefined;
      if (run && !isTerminalRun(run.status))
        await cancelRun(run.projectId, run.id);
      await closeQueryPools();
      closeDatabase();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  210_000,
);
