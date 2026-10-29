import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePreparedReference } from "@/lib/verify/prepared";
import {
  createIngestionChecks,
  type IngestionCheckInput,
} from "@/lib/verify/ingestion";
import type { SemanticModel } from "@/lib/semantic/types";
import type {
  CheckCase,
  ReferenceExecutor,
  ReferenceRows,
  VerificationColumn,
} from "@/lib/verify/types";

const source: VerificationColumn[] = [
  { id: "0", name: "Order ID", type: "text" },
  { id: "1", name: "Order Date", type: "date" },
  { id: "2", name: "Sales", type: "decimal" },
  { id: "3", name: "Profit", type: "decimal" },
  { id: "4", name: "Customer", type: "text" },
  { id: "5", name: "Segment", type: "text" },
];
const model: SemanticModel = {
  projectId: "project",
  version: "version",
  factTableId: "fact",
  measures: [],
  hierarchies: [],
  tables: [
    {
      id: "fact",
      name: "fact_sales",
      schema: "dw",
      sqlName: "fact_sales",
      kind: "fact",
      keyColumnId: "fact:key",
      columns: [
        {
          id: "fact:key",
          tableId: "fact",
          name: "Fact key",
          sqlName: "fact_key",
          type: "number",
          role: "key",
        },
        {
          id: "sales",
          tableId: "fact",
          name: "Sales",
          sqlName: "sales",
          sourceColumnId: "2",
          type: "number",
          role: "measure-source",
        },
        {
          id: "profit",
          tableId: "fact",
          name: "Profit",
          sqlName: "profit",
          sourceColumnId: "3",
          type: "number",
          role: "measure-source",
        },
        {
          id: "order",
          tableId: "fact",
          name: "Order ID",
          sqlName: "order_id",
          sourceColumnId: "0",
          type: "string",
          role: "attribute",
        },
        {
          id: "customer_fk",
          tableId: "fact",
          name: "Customer key",
          sqlName: "customer_key",
          sourceColumnId: "4",
          type: "number",
          role: "key",
        },
        {
          id: "date_fk",
          tableId: "fact",
          name: "Date key",
          sqlName: "DateKey",
          sourceColumnId: "1",
          type: "number",
          role: "key",
        },
      ],
    },
    {
      id: "customer",
      name: "dim_customer",
      schema: "dw",
      sqlName: "dim_customer",
      kind: "dimension",
      keyColumnId: "customer:key",
      columns: [
        {
          id: "customer:key",
          tableId: "customer",
          name: "Customer key",
          sqlName: "customer_key",
          type: "number",
          role: "key",
        },
        {
          id: "customer:name",
          tableId: "customer",
          name: "Customer",
          sqlName: "customer_name",
          sourceColumnId: "4",
          type: "string",
          role: "attribute",
        },
        {
          id: "customer:segment",
          tableId: "customer",
          name: "Segment",
          sqlName: "segment",
          sourceColumnId: "5",
          type: "string",
          role: "attribute",
        },
      ],
    },
    {
      id: "date",
      name: "dim_date",
      schema: "dw",
      sqlName: "dim_date",
      kind: "dimension",
      keyColumnId: "date:key",
      columns: [
        {
          id: "date:key",
          tableId: "date",
          name: "Date key",
          sqlName: "DateKey",
          type: "number",
          role: "key",
        },
        {
          id: "date:date",
          tableId: "date",
          name: "Date",
          sqlName: "Date",
          type: "date",
          role: "attribute",
        },
      ],
    },
  ],
  relationships: [
    {
      id: "customer",
      fromTableId: "fact",
      fromColumnId: "customer_fk",
      toTableId: "customer",
      toColumnId: "customer:key",
      cardinality: "many-to-one",
    },
    {
      id: "date",
      fromTableId: "fact",
      fromColumnId: "date_fk",
      toTableId: "date",
      toColumnId: "date:key",
      cardinality: "many-to-one",
    },
  ],
  date: {
    tableId: "date",
    dateColumnId: "date:date",
    keyColumnId: "date:key",
    factColumnId: "date_fk",
  },
};
let directory: string, input: IngestionCheckInput;
function rows(sql: string): ReferenceRows {
  if (sql.includes("prepared-to-staged")) return [{ staged_rows: 4 }];
  if (sql.includes("row balance")) return [{ fact_rows: 3, rejected_rows: 0 }];
  if (sql.includes("fact row count")) return [{ fact_rows: 3 }];
  if (sql.includes("null key")) return [{ null_keys: 0 }];
  if (sql.includes("values sales"))
    return [
      { null_cells: 1, sum_value: 30.3, min_value: 10.1, max_value: 20.2 },
    ];
  if (sql.includes("values profit"))
    return [
      { null_cells: 0, sum_value: 6.06, min_value: 1.01, max_value: 3.03 },
    ];
  if (sql.includes("values order")) return [{ null_cells: 0 }];
  if (sql.includes("orphan keys")) return [{ orphan_keys: 0 }];
  if (sql.includes("Unknown counts"))
    return [{ unknown_members: 1, unknown_facts: 0 }];
  if (sql.includes("dimension count")) return [{ dimension_rows: 3 }];
  if (sql.includes("dimension distinct")) return [{ distinct_values: 2 }];
  if (sql.includes("calendar coverage"))
    return [
      { min_date: "2023-01-01", max_date: "2025-01-03", covered_dates: 3 },
    ];
  if (sql.includes("rejected row count")) return [{ rejected_rows: 0 }];
  if (sql.includes("rejected reasons") || sql.includes("rejected row examples"))
    return [];
  throw new Error(`Unexpected reference SQL: ${sql}`);
}
const run = (check: CheckCase) => check.run(new AbortController().signal);
function check(id: string, patch: Partial<IngestionCheckInput> = {}) {
  const found = createIngestionChecks({ ...input, ...patch }).find(
    (check) => check.id === id,
  );
  expect(found, id).toBeDefined();
  return found!;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "df-verify-ingestion-"));
  const file = join(directory, "prepared.csv");
  await writeFile(
    file,
    "Order ID,Order Date,Sales,Profit,Customer,Segment\nO1,2024-01-01,10.10,1.01,A,Consumer\nO2,2024-01-02,20.20,2.02,B,Business\nO2,2024-01-02,20.20,2.02,B,Business\nO3,2024-01-03,,3.03,A,Consumer\n",
  );
  input = {
    projectId: "project",
    model: structuredClone(model),
    columns: source,
    prepared: await computePreparedReference(file, source),
    load: {
      id: "11111111-1111-4111-8111-111111111111",
      mode: "full",
      rowsStaged: 4,
      rowsLoaded: 3,
      rowsRejected: 0,
      dedupe: true,
      finishedAt: "2026-10-29T12:00:00.000Z",
    },
    reference: async (query) => rows(query.sql),
  };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("independent ingestion checks with SQL driver doubles", () => {
  it("passes every applicable check against an independently computed three-row warehouse fixture", async () => {
    const checks = createIngestionChecks(input);
    expect(checks.length).toBeGreaterThan(20);
    for (const entry of checks)
      expect(await run(entry), entry.id).toMatchObject({
        status: "pass",
        nextStep: "",
      });
    // A separate hand calculation: 4 prepared rows = 3 loaded + 0 rejected + 1 duplicate.
    expect((await run(check("ingestion.rows.balance"))).actual).toEqual({
      reconciledRows: 3 + 0 + 1,
      factRows: 3,
      rejectedRows: 0,
      removedDuplicates: 1,
    });
  });
  it("reports each mismatching scalar check rather than changing the reference to match the driver", async () => {
    const scalarIds = createIngestionChecks(input)
      .filter(
        (entry) =>
          ![
            "ingestion.rows.balance",
            "ingestion.unknown.customer",
            "ingestion.unknown.date",
            "ingestion.date.coverage.date",
            "ingestion.rejects",
          ].includes(entry.id),
      )
      .map((entry) => entry.id);
    for (const id of scalarIds) {
      const reference: ReferenceExecutor = async (query) =>
        rows(query.sql).map((row) =>
          Object.fromEntries(Object.keys(row).map((key) => [key, 9999])),
        );
      const outcome = await run(check(id, { reference }));
      expect(outcome.status, id).toBe("fail");
      expect(outcome.nextStep, id).not.toBe("");
      expect(outcome.sql, id).toContain("SELECT");
    }
  });
  it("uses numeric tolerances only for values, with an explicit signed difference", async () => {
    const reference: ReferenceExecutor = async (query) =>
      query.sql.includes("values sales")
        ? [
            {
              null_cells: 1,
              sum_value: 30.305,
              min_value: 10.1,
              max_value: 20.2,
            },
          ]
        : rows(query.sql);
    const inTolerance = await run(
      check("ingestion.numeric.sum.sales", { reference }),
    );
    expect(inTolerance.status).toBe("pass");
    expect(inTolerance.difference).toBeCloseTo(0.005);
    expect(inTolerance.tolerance).toBe(0.01);
    const strict = createIngestionChecks(
      { ...input, reference },
      { absolute: 0.001, relative: 0 },
    ).find((entry) => entry.id === "ingestion.numeric.sum.sales")!;
    expect((await run(strict)).status).toBe("fail");
    expect(() => createIngestionChecks(input, { relative: -1 })).toThrow(
      /tolerances/,
    );
  });
  it("changes prepared expectations when duplicate removal is disabled", async () => {
    const reference: ReferenceExecutor = async (query) =>
      query.sql.includes("values sales")
        ? [{ null_cells: 1, sum_value: 50.5, min_value: 10.1, max_value: 20.2 }]
        : query.sql.includes("row balance")
          ? [{ fact_rows: 4, rejected_rows: 0 }]
          : rows(query.sql);
    const load = { ...input.load!, dedupe: false, rowsLoaded: 4 };
    expect(
      (await run(check("ingestion.numeric.sum.sales", { reference, load })))
        .expected,
    ).toBe(10.1 + 20.2 + 20.2);
    expect(
      (await run(check("ingestion.numeric.sum.sales", { reference, load })))
        .status,
    ).toBe("pass");
    expect(
      (await run(check("ingestion.rows.balance", { reference, load }))).actual,
    ).toMatchObject({ removedDuplicates: 0, reconciledRows: 4 });
  });
  it("does not silently sum rejected rows or compare an incremental snapshot to the whole warehouse", async () => {
    const reference = vi.fn<ReferenceExecutor>(async (query) =>
      rows(query.sql),
    );
    expect(
      (
        await run(
          check("ingestion.numeric.sum.sales", {
            reference,
            load: { ...input.load!, rowsRejected: 1 },
          }),
        )
      ).explanation,
    ).toContain("exact accepted-row subset");
    expect(
      (
        await run(
          check("ingestion.column.null.sales", {
            reference,
            load: { ...input.load!, mode: "incremental" },
          }),
        )
      ).status,
    ).toBe("skipped");
    expect(
      (
        await run(
          check("ingestion.rows.balance", {
            reference,
            load: { ...input.load!, mode: "incremental" },
          }),
        )
      ).status,
    ).toBe("skipped");
    expect(reference).not.toHaveBeenCalled();
    for (const entry of createIngestionChecks({
      ...input,
      reference,
      load: null,
    }))
      expect((await run(entry)).status, entry.id).toBe("skipped");
  });
  it("reports missing staging evidence and source/schema mappings honestly", async () => {
    expect(
      (
        await run(
          check("ingestion.rows.prepared-staged", {
            reference: async () => [],
          }),
        )
      ).status,
    ).toBe("fail");
    const absent = structuredClone(input.model);
    delete absent.tables[0].columns.find(
      (column) => column.id === "customer_fk",
    )!.sourceColumnId;
    expect(
      (await run(check("ingestion.dimension.rows.customer", { model: absent })))
        .status,
    ).toBe("skipped");
    const noFact = { ...input.model, tables: [] };
    expect(
      (await run(createIngestionChecks({ ...input, model: noFact })[0])).status,
    ).toBe("skipped");
    const noDate = {
      ...input.prepared,
      columns: input.prepared.columns.map((column) =>
        column.name === "Order Date"
          ? { ...column, min: null, max: null }
          : column,
      ),
    };
    expect(
      (await run(check("ingestion.date.coverage.date", { prepared: noDate })))
        .status,
    ).toBe("skipped");
  });
  it("preserves driver errors as failures with the attempted SQL and propagates cancellation", async () => {
    for (const entry of createIngestionChecks({
      ...input,
      reference: async () => {
        throw new Error("driver-double outage");
      },
    })) {
      const outcome = await run(entry);
      expect(outcome.status, entry.id).toBe("fail");
      expect(outcome.actual).toMatchObject({ error: "driver-double outage" });
      expect(outcome.sql, entry.id).toContain("SELECT");
    }
    const controller = new AbortController();
    controller.abort(new Error("Stop checks"));
    await expect(
      check("ingestion.rows.prepared-staged").run(controller.signal),
    ).rejects.toThrow("Stop checks");
  });
  it("reports Unknown-member counts, invalid Unknown cardinality, NULL keys and orphans", async () => {
    const reference: ReferenceExecutor = async (query) =>
      query.sql.includes("Unknown counts")
        ? [{ unknown_members: 1, unknown_facts: 2 }]
        : query.sql.includes("orphan keys")
          ? [{ orphan_keys: 1 }]
          : query.sql.includes("null key")
            ? [{ null_keys: 1 }]
            : rows(query.sql);
    expect(
      (await run(check("ingestion.unknown.customer", { reference }))).status,
    ).toBe("warn");
    expect(
      (await run(check("ingestion.key.orphan.customer", { reference }))).status,
    ).toBe("fail");
    expect(
      (await run(check("ingestion.key.null.customer_fk", { reference })))
        .status,
    ).toBe("fail");
    const invalidUnknown: ReferenceExecutor = async () => [
      { unknown_members: 0, unknown_facts: 2 },
    ];
    expect(
      (
        await run(
          check("ingestion.unknown.customer", { reference: invalidUnknown }),
        )
      ).status,
    ).toBe("fail");
  });
  it("checks date-range endpoints and internal calendar gaps independently", async () => {
    for (const patch of [
      { min_date: "2024-01-02", max_date: "2025-01-03", covered_dates: 3 },
      { min_date: "2023-01-01", max_date: "2025-01-03", covered_dates: 2 },
      { min_date: "2023-01-01", max_date: "2024-01-02", covered_dates: 3 },
    ])
      expect(
        (
          await run(
            check("ingestion.date.coverage.date", {
              reference: async () => (patch ? [patch] : []),
            }),
          )
        ).status,
      ).toBe("fail");
  });
  it("lists rejected-row reasons and logical row numbers without exposing raw source payloads", async () => {
    const reference: ReferenceExecutor = async (query) =>
      query.sql.includes("rejected row count")
        ? [{ rejected_rows: 1 }]
        : query.sql.includes("rejected reasons")
          ? [{ reason: "Invalid date", rejected_rows: 1 }]
          : query.sql.includes("rejected row examples")
            ? [{ source_row_number: 3, reason: "Invalid date" }]
            : rows(query.sql);
    const outcome = await run(
      check("ingestion.rejects", {
        reference,
        load: { ...input.load!, rowsRejected: 1 },
      }),
    );
    expect(outcome.status).toBe("warn");
    expect(outcome.actual).toMatchObject({
      rejectedRows: 1,
      reasons: [{ reason: "Invalid date", count: 1 }],
      rows: [{ rowNumber: 3, reason: "Invalid date" }],
    });
    expect(JSON.stringify(outcome.actual)).not.toContain("raw_json");
    expect((await run(check("ingestion.rejects", { reference }))).status).toBe(
      "fail",
    );
  });
  it("distinguishes legitimate empty numeric aggregates from a returned zero", async () => {
    const prepared = {
      ...input.prepared,
      deduplicatedColumns: input.prepared.deduplicatedColumns.map((column) =>
        column.name === "Sales"
          ? {
              ...column,
              numeric: { count: 0, nulls: 3, sum: 0, min: null, max: null },
            }
          : column,
      ),
    };
    expect(
      (
        await run(
          check("ingestion.numeric.sum.sales", {
            prepared,
            reference: async () => [{ sum_value: null }],
          }),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await run(
          check("ingestion.numeric.sum.sales", {
            prepared,
            reference: async () => [{ sum_value: 0 }],
          }),
        )
      ).status,
    ).toBe("fail");
  });
  it("does not turn invalid typed or padded Unknown text references into passing distinct/aggregate checks", async () => {
    const prepared = {
      ...input.prepared,
      warnings: [
        'Column "Sales" contains 1 non-empty value(s) invalid for its saved decimal type.',
      ],
      columns: input.prepared.columns.map((column) =>
        column.name === "Segment" ? { ...column, nulls: 1 } : column,
      ),
    };
    expect(
      (await run(check("ingestion.numeric.sum.sales", { prepared }))).status,
    ).toBe("skipped");
    expect(
      (
        await run(
          check("ingestion.dimension.distinct.customer:segment", { prepared }),
        )
      ).status,
    ).toBe("skipped");
    expect(
      (await run(check("ingestion.prepared-warnings", { prepared }))).status,
    ).toBe("warn");
  });
  it("quotes physical identifiers, parameterizes the run ID and never invokes compiler/generator code", async () => {
    const captured: string[] = [],
      execute: ReferenceExecutor = async (query) => {
        captured.push(query.sql);
        expect(query.sql).not.toContain(input.load!.id);
        expect(query.params[0]?.value).toBe(input.load!.id);
        return [{ staged_rows: 4 }];
      };
    await run(check("ingestion.rows.prepared-staged", { reference: execute }));
    expect(captured[0]).toMatchInlineSnapshot(`
      "-- independent ingestion: prepared-to-staged
      SELECT TOP (1) [rows_in] AS [staged_rows]
      FROM [etl].[run_log]
      WHERE [run_id] = CONVERT(UNIQUEIDENTIFIER, @__verify_run) AND [step] = N'01_staging' AND [status] = N'Succeeded'
      ORDER BY [finished_at] DESC, [started_at] DESC;"
    `);
    const quoted = structuredClone(input.model);
    quoted.tables[0].sqlName = "fact]sales";
    const reference: ReferenceExecutor = async (query) => {
      expect(query.sql).toContain("[fact]]sales]");
      return [{ fact_rows: 3 }];
    };
    expect(
      (
        await run(
          check("ingestion.rows.fact-summary", { model: quoted, reference }),
        )
      ).status,
    ).toBe("pass");
    const sourceCode = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(process.cwd(), "lib/verify/ingestion.ts"), "utf8"),
    );
    expect(sourceCode).not.toMatch(
      /from\s+["'].*(?:semantic\/expr|semantic\/query\/compile|sql\/|profiler|prepare\/engine)/,
    );
  });
  it("flattens metadata IDs before SQL comments so they cannot introduce executable statements", async () => {
    const hostile = structuredClone(input.model);
    const dimension = hostile.tables.find((table) => table.id === "customer")!;
    const original = dimension.id;
    dimension.id = "customer\nDROP TABLE evil;--";
    hostile.relationships.find(
      (relationship) => relationship.toTableId === original,
    )!.toTableId = dimension.id;
    const captured: string[] = [];
    const reference: ReferenceExecutor = async (query) => {
      captured.push(query.sql);
      return rows(query.sql);
    };
    for (const entry of createIngestionChecks({
      ...input,
      model: hostile,
      reference,
    }).filter((entry) => entry.id.startsWith("ingestion.dimension.rows")))
      await run(entry);
    expect(captured).toHaveLength(1);
    expect(captured[0].split("\n")[0]).toContain("customer DROP TABLE evil;--");
    expect(captured[0].split("\n").slice(1).join("\n")).not.toContain(
      "DROP TABLE",
    );
  });
});
