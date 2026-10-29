import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createEmptyReport,
  reportDefinitionSchema,
  type SavedReport,
} from "@/lib/reports/schema";
import {
  paginateReport,
  type ReportExecutionData,
} from "@/lib/reports/pagination";
import { generateReportCsv, generateReportXlsx } from "@/lib/reports/export";
import type { QueryResult, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import {
  createReportChecks,
  independentReportContexts,
  reportExportComparisons,
  reportSubtotalComparisons,
  type ReportObservation,
} from "@/lib/verify/reports";
import type { ReferenceExecutor } from "@/lib/verify/types";

function model(): SemanticModel {
  return {
    projectId: randomUUID(),
    version: "test-v1",
    factTableId: "fact",
    tables: [
      {
        id: "fact",
        name: "fact_sales",
        sqlName: "fact_sales",
        schema: "dw",
        kind: "fact",
        keyColumnId: "fact:key",
        columns: [
          {
            id: "fact:key",
            tableId: "fact",
            name: "FactKey",
            sqlName: "FactKey",
            type: "number",
            role: "key",
          },
          {
            id: "sales-source",
            tableId: "fact",
            name: "Sales",
            sqlName: "Sales",
            type: "number",
            role: "measure-source",
          },
          {
            id: "profit-source",
            tableId: "fact",
            name: "Profit",
            sqlName: "Profit",
            type: "number",
            role: "measure-source",
          },
          {
            id: "product-fk",
            tableId: "fact",
            name: "ProductKey",
            sqlName: "ProductKey",
            type: "number",
            role: "key",
          },
        ],
      },
      {
        id: "product",
        name: "dim_product",
        sqlName: "dim_product",
        schema: "dw",
        kind: "dimension",
        keyColumnId: "product:key",
        columns: [
          {
            id: "product:key",
            tableId: "product",
            name: "ProductKey",
            sqlName: "ProductKey",
            type: "number",
            role: "key",
          },
          {
            id: "category",
            tableId: "product",
            name: "Category",
            sqlName: "Category",
            type: "string",
            role: "attribute",
            distinctCount: 2,
          },
        ],
      },
    ],
    relationships: [
      {
        id: "product-rel",
        fromTableId: "fact",
        fromColumnId: "product-fk",
        toTableId: "product",
        toColumnId: "product:key",
        cardinality: "many-to-one",
      },
    ],
    measures: [
      {
        id: "sales",
        name: "Sales",
        expression: "SUM('fact_sales'[Sales])",
        format: "currency",
        folder: "",
        description: "",
        isAuto: true,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "margin",
        name: "Margin",
        expression: "DIVIDE(SUM('fact_sales'[Profit]), [Sales])",
        format: "percent",
        folder: "",
        description: "",
        isAuto: false,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ],
    hierarchies: [],
  };
}
const category = { table: "product", column: "category" };
function report(projectId: string): SavedReport {
  const empty = createEmptyReport("Sales report");
  return {
    ...empty,
    id: randomUUID(),
    projectId,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    definition: reportDefinitionSchema.parse({
      ...empty.definition,
      parameters: [
        {
          id: "category",
          name: "Category",
          type: "single",
          attribute: category,
          allowAll: true,
        },
      ],
      items: [
        {
          id: "table",
          type: "table",
          title: "Sales by category",
          data: {
            kind: "fields",
            rows: [category],
            values: ["sales", "margin"],
            filters: [],
            sort: [],
          },
          groups: [category],
          columns: [
            {
              id: "category",
              label: "Category",
              binding: { kind: "attribute", attribute: category },
            },
            {
              id: "sales",
              label: "Sales",
              binding: { kind: "measure", measure: "sales" },
              format: "currency",
            },
            {
              id: "margin",
              label: "Margin",
              binding: { kind: "measure", measure: "margin" },
              format: "percent",
            },
          ],
          subtotals: true,
          grandTotal: true,
        },
      ],
    }),
  };
}
const independentRows = [
  { category: "A", sales: 100, profit: 10 },
  { category: "B", sales: 200, profit: 60 },
];
function result(grouped: boolean, filtered?: string): QueryResult {
  const rows = independentRows.filter(
      (r) => !filtered || r.category === filtered,
    ),
    sales = rows.reduce((s, r) => s + r.sales, 0),
    profit = rows.reduce((s, r) => s + r.profit, 0);
  return {
    columns: [
      ...(grouped
        ? [
            {
              key: "a0",
              name: "Category",
              type: "string" as const,
              role: "attribute" as const,
            },
          ]
        : []),
      { key: "m0", name: "Sales", type: "number", role: "measure" },
      { key: "m1", name: "Margin", type: "number", role: "measure" },
    ],
    rows: grouped
      ? rows.map((r) => ({
          a0: r.category,
          m0: r.sales,
          m1: r.profit / r.sales,
        }))
      : [{ m0: sales, m1: sales ? profit / sales : null }],
    rowCount: grouped ? rows.length : 1,
    truncated: false,
    elapsedMs: 1,
    fromCache: false,
    sql: "SELECT actual_report_engine",
  };
}
function observed(
  saved: SavedReport,
  semantic: SemanticModel,
  filtered?: string,
  grandDelta = 0,
): ReportObservation {
  const grand = result(false, filtered);
  grand.rows[0].m0 = Number(grand.rows[0].m0) + grandDelta;
  const data: ReportExecutionData = {
    runAt: "2024-01-01T00:00:00Z",
    parameters: { category: filtered ?? null },
    items: {
      table: {
        result: result(true, filtered),
        rows: [category],
        measures: ["sales", "margin"],
        totals: [
          {
            key: "category",
            groupBy: [category],
            result: result(true, filtered),
          },
          { key: "grand", groupBy: [], result: grand },
        ],
      },
    },
  };
  return {
    data,
    preview: paginateReport(saved.definition, data, semantic, saved.name),
    csv: generateReportCsv(saved.definition, data, semantic, saved.name),
    xlsx: generateReportXlsx(saved.definition, data, semantic, saved.name),
  };
}
const reference: ReferenceExecutor = async (query) => {
  const grouped = query.columns.some((c) => c.role === "attribute"),
    filtered = query.params.find(
      (p) => p.value === "A" || p.value === "B",
    )?.value;
  const rows = independentRows.filter(
      (r) =>
        !filtered ||
        (query.sql.includes("NOT IN")
          ? r.category !== filtered
          : r.category === filtered),
    ),
    groups = grouped ? rows.map((r) => [r]) : [rows];
  return groups.map((group) =>
    Object.fromEntries(
      query.columns.map((column) => {
        if (column.role === "attribute")
          return [column.key, group[0]?.category ?? null];
        const sales = group.reduce((s, r) => s + r.sales, 0),
          profit = group.reduce((s, r) => s + r.profit, 0);
        return [
          column.key,
          column.name.toLowerCase() === "margin"
            ? sales
              ? profit / sales
              : null
            : sales,
        ];
      }),
    ),
  ) as Record<string, QueryValue>[];
};
const signal = () => new AbortController().signal;
function check(
  id: string,
  options: {
    delta?: number;
    brokenReference?: boolean;
    truncate?: boolean;
  } = {},
) {
  const semantic = model(),
    saved = report(semantic.projectId),
    observeReport = vi.fn(
      async (_saved: SavedReport, parameters: Record<string, unknown>) => {
        const observation = observed(
          saved,
          semantic,
          typeof parameters.category === "string"
            ? parameters.category
            : undefined,
          options.delta,
        );
        if (options.truncate) observation.preview.truncated = true;
        return observation;
      },
    );
  const checks = createReportChecks({
    model: semantic,
    reports: [saved],
    reference: options.brokenReference
      ? async () => {
          throw new Error("Reference SQL failed");
        }
      : reference,
    observeReport,
  });
  return {
    semantic,
    saved,
    observeReport,
    case: checks.find((c) => c.id.endsWith(id))!,
    checks,
  };
}

describe("independent report contexts and subtotal arithmetic", () => {
  it("reconstructs defaults, groups, grand totals and parameter filters without the production report planner", () => {
    const semantic = model(),
      saved = report(semantic.projectId);
    const contexts = independentReportContexts(
      saved,
      { category: "A" },
      semantic,
    );
    expect(contexts[0].query.measures).toEqual(["sales", "margin"]);
    expect(contexts[0].query.filters).toEqual([
      { attribute: category, op: "eq", value: "A" },
    ]);
    expect(contexts[0].totals.map((t) => t.groupBy)).toEqual([[category], []]);
    expect(contexts[0].additive).toEqual(["sales"]);
  });
  it("sums additive subtotals and deliberately never adds ratios", () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      observation = observed(saved, semantic);
    const compared = reportSubtotalComparisons(saved, observation, semantic);
    expect(compared).toHaveLength(1);
    expect(compared[0]).toMatchObject({
      expected: 300,
      actual: 300,
      pass: true,
    });
    expect(compared[0].label).toContain("Sales");
  });
  it("detects a grand-total mismatch without changing the report or production numbers", async () => {
    const { case: referenceCase } = check(":reference", { delta: 20 });
    const result = await referenceCase.run(signal());
    expect(result.status).toBe("fail");
    expect(result.referenceSql).toContain("SELECT");
    expect(result.sql).toContain("actual_report_engine");
    const { case: subtotals } = check(":subtotals", { delta: 20 });
    expect((await subtotals.run(signal())).status).toBe("fail");
  });
  it("passes correct independently calculated report totals and parameter-filter outcomes", async () => {
    const { case: defaultCase, checks, observeReport } = check(":reference");
    expect((await defaultCase.run(signal())).status).toBe("pass");
    expect(
      (
        await checks
          .find((c) => c.id.endsWith(":parameter:category"))!
          .run(signal())
      ).status,
    ).toBe("pass");
    expect(observeReport).toHaveBeenCalledWith(
      expect.anything(),
      { category: "A" },
      expect.any(AbortSignal),
    );
  });

  it("detects a preview-only grand-total corruption even when query data and export bytes are correct", async () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      observation = observed(saved, semantic);
    const grand = observation.preview.pages
      .flatMap((page) => page.elements)
      .find(
        (element) =>
          element.kind === "tableRow" && element.rowKind === "grandTotal",
      );
    if (!grand || grand.kind !== "tableRow")
      throw new Error("Expected a grand-total preview row");
    grand.cells.find((cell) => cell.field === "sales")!.raw = 999;
    const outcome = await createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport: async () => observation,
    })[0].run(signal());
    expect(outcome.status).toBe("fail");
    expect(JSON.stringify(outcome.expected)).toContain(
      "Rendered preview vs independent SQL",
    );
  });
  it("uses a different parameter member from its saved default when one exists", async () => {
    const semantic = model(),
      saved = report(semantic.projectId);
    saved.definition.parameters[0].default = "A";
    const observeReport = vi.fn(
      async (_saved: SavedReport, parameters: Record<string, unknown>) =>
        observed(saved, semantic, String(parameters.category)),
    );
    const current = createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport,
    }).find((item) => item.id.endsWith(":parameter:category"))!;
    expect((await current.run(signal())).status).toBe("pass");
    expect(observeReport).toHaveBeenCalledWith(
      saved,
      { category: "B" },
      expect.any(AbortSignal),
    );
  });
  it("detects subtotals bound to the wrong visible group instead of accepting their aggregate sum", async () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      observation = observed(saved, semantic);
    const subtotals = observation.preview.pages
      .flatMap((page) => page.elements)
      .filter(
        (element) =>
          element.kind === "tableRow" && element.rowKind === "subtotal",
      );
    if (
      subtotals.length !== 2 ||
      subtotals[0].kind !== "tableRow" ||
      subtotals[1].kind !== "tableRow"
    )
      throw new Error("Expected two subtotal rows");
    const first = subtotals[0].cells.find((cell) => cell.field === "sales")!,
      second = subtotals[1].cells.find((cell) => cell.field === "sales")!;
    [first.raw, second.raw] = [second.raw, first.raw];
    const outcome = await createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport: async () => observation,
    })[0].run(signal());
    expect(outcome.status).toBe("fail");
  });
  it("uses absolute/relative tolerance while preserving the actual discrepancy", async () => {
    const { case: within } = check(":reference", { delta: 0.005 });
    const pass = await within.run(signal());
    expect(pass.status).toBe("pass");
    expect(Math.abs(pass.difference ?? 0)).toBeCloseTo(0.005, 8);
    expect(
      (await check(":reference", { delta: 0.02 }).case.run(signal())).status,
    ).toBe("fail");
  });
  it("skips an incomplete preview and fails query/observation errors explicitly", async () => {
    expect(
      (await check(":reference", { truncate: true }).case.run(signal())).status,
    ).toBe("warn");
    expect(
      (await check(":reference", { brokenReference: true }).case.run(signal()))
        .status,
    ).toBe("fail");
    const semantic = model(),
      saved = report(semantic.projectId);
    const broken = createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport: async () => {
        throw new Error("Export unavailable");
      },
    });
    expect(await broken[0].run(signal())).toMatchObject({
      status: "fail",
      explanation: "Export unavailable",
    });
  });
  it("reports missing and unsupported observations instead of inventing passes", async () => {
    const semantic = model(),
      saved = report(semantic.projectId);
    expect(
      (
        await createReportChecks({
          model: semantic,
          reports: [],
          reference,
        })[0].run(signal())
      ).status,
    ).toBe("skipped");
    expect(
      (
        await createReportChecks({
          model: semantic,
          reports: [saved],
          reference,
        })[0].run(signal())
      ).status,
    ).toBe("skipped");
    const missing = observed(saved, semantic);
    missing.data.items = {};
    expect(
      (
        await createReportChecks({
          model: semantic,
          reports: [saved],
          reference,
          observeReport: async () => missing,
        })[0].run(signal())
      ).status,
    ).toBe("fail");
  });
  it("does not let an unsupported custom measure hide a supported measure failure", async () => {
    const semantic = model(),
      saved = report(semantic.projectId);
    semantic.measures[1].expression = "UNSUPPORTED_FUNCTION(1)";
    const cases = createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport: async () => observed(saved, semantic, undefined, 10),
    });
    expect((await cases[0].run(signal())).status).toBe("fail");
  });
  it("binds chart values directly to independent grouped results", async () => {
    const semantic = model(),
      saved = report(semantic.projectId);
    saved.definition.items = reportDefinitionSchema.parse({
      ...saved.definition,
      items: [
        {
          id: "table",
          type: "chart",
          title: "Sales",
          data: {
            kind: "fields",
            rows: [category],
            values: ["sales", "margin"],
          },
        },
      ],
    }).items;
    const observation = observed(saved, semantic);
    const cases = () =>
      createReportChecks({
        model: semantic,
        reports: [saved],
        reference,
        observeReport: async () => observation,
      });
    expect((await cases()[0].run(signal())).status).toBe("pass");
    const chart = observation.preview.pages
      .flatMap((page) => page.elements)
      .find((element) => element.kind === "chart");
    if (!chart || chart.kind !== "chart")
      throw new Error("Expected chart preview");
    chart.data[0].values.m0 = 999;
    expect((await cases()[0].run(signal())).status).toBe("fail");
  });
  it("reconciles matrix detail cells, row totals, column totals and grand total independently", async () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      subcategory = { table: "product", column: "subcategory" };
    semantic.tables[1].columns.push({
      id: "subcategory",
      tableId: "product",
      name: "Subcategory",
      sqlName: "Subcategory",
      type: "string",
      role: "attribute",
    });
    saved.definition.items = reportDefinitionSchema.parse({
      ...saved.definition,
      items: [
        {
          id: "table",
          type: "matrix",
          title: "Matrix",
          data: { kind: "fields", rows: [category], values: ["sales"] },
          rows: [category],
          columns: [subcategory],
          values: ["sales"],
        },
      ],
    }).items;
    const metrics = [result(false).columns[0]],
      catColumn = {
        key: "a0",
        name: "Category",
        type: "string" as const,
        role: "attribute" as const,
      },
      subColumn = { ...catColumn, key: "a1", name: "Subcategory" },
      matrixResult = (refs: (typeof category)[]): QueryResult => {
        const grouped = refs.some((ref) => ref.column === "category");
        const groups = grouped
          ? independentRows.map((row) => [row])
          : [independentRows];
        return {
          ...result(false),
          columns: [
            ...refs.map((ref) =>
              ref.column === "category" ? catColumn : subColumn,
            ),
            ...metrics,
          ],
          rows: groups.map((rows) => ({
            ...(refs.some((ref) => ref.column === "category")
              ? { a0: rows[0].category }
              : {}),
            ...(refs.some((ref) => ref.column === "subcategory")
              ? { a1: "X" }
              : {}),
            m0: rows.reduce((sum, row) => sum + row.sales, 0),
          })),
        };
      };
    const refs = [[category], [category, subcategory], [subcategory], []],
      data: ReportExecutionData = {
        runAt: "2024-01-01T00:00:00Z",
        parameters: {},
        items: {
          table: {
            result: matrixResult([category, subcategory]),
            rows: [category, subcategory],
            measures: ["sales"],
            totals: refs.map((groupBy) => ({
              key: JSON.stringify(groupBy),
              groupBy,
              result: matrixResult(groupBy),
            })),
          },
        },
      },
      observation: ReportObservation = {
        data,
        preview: paginateReport(saved.definition, data, semantic, saved.name),
      },
      matrixReference: ReferenceExecutor = async (query) => {
        const attrs = query.columns.filter(
            (column) => column.role === "attribute",
          ),
          grouped = attrs.some((column) => column.name === "Category"),
          groups = grouped
            ? independentRows.map((row) => [row])
            : [independentRows];
        return groups.map((rows) =>
          Object.fromEntries(
            query.columns.map((column) => [
              column.key,
              column.role === "measure"
                ? rows.reduce((sum, row) => sum + row.sales, 0)
                : column.name === "Category"
                  ? rows[0].category
                  : "X",
            ]),
          ),
        );
      },
      cases = () =>
        createReportChecks({
          model: semantic,
          reports: [saved],
          reference: matrixReference,
          observeReport: async () => observation,
        });
    expect((await cases()[0].run(signal())).status).toBe("pass");
    const grand = observation.preview.pages
      .flatMap((page) => page.elements)
      .find(
        (element) =>
          element.kind === "tableRow" && element.rowKind === "grandTotal",
      );
    if (!grand || grand.kind !== "tableRow")
      throw new Error("Expected grand total");
    grand.cells.find((cell) => cell.field === "sales")!.raw = 999;
    expect((await cases()[0].run(signal())).status).toBe("fail");
  });
  it("propagates cancellation instead of counting it as a failed check", async () => {
    const { case: current } = check(":reference"),
      controller = new AbortController();
    controller.abort();
    await expect(current.run(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("independent parsing of exported report numbers", () => {
  for (const format of ["csv", "xlsx"] as const)
    it(`${format.toUpperCase()} detail and total cells reconcile with preview raw values`, async () => {
      const { case: current } = check(`:${format}`);
      expect((await current.run(signal())).status).toBe("pass");
    });
  it("finds a changed CSV total in the exported bytes", () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      observation = observed(saved, semantic);
    observation.csv = new TextEncoder().encode(
      new TextDecoder()
        .decode(observation.csv)
        .replace("Grand total,300,", "Grand total,301,"),
    );
    expect(
      reportExportComparisons(saved, observation, semantic, "csv").some(
        (c) => !c.pass,
      ),
    ).toBe(true);
  });
  it("detects an export that swaps detail and grand-total values while preserving every numeric value", () => {
    const semantic = model(),
      saved = report(semantic.projectId),
      observation = observed(saved, semantic);
    const csv = new TextDecoder().decode(observation.csv);
    expect(csv).toContain("A,100,");
    expect(csv).toContain("Grand total,300,");
    observation.csv = new TextEncoder().encode(
      csv
        .replace("A,100,", "A,300,")
        .replace("Grand total,300,", "Grand total,100,"),
    );
    expect(
      reportExportComparisons(saved, observation, semantic, "csv").some(
        (comparison) => !comparison.pass,
      ),
    ).toBe(true);
  });
  it("handles absent and malformed artifacts explicitly", async () => {
    const { semantic, saved } = check(":csv");
    const observation = observed(saved, semantic);
    observation.csv = undefined;
    const cases = createReportChecks({
      model: semantic,
      reports: [saved],
      reference,
      observeReport: async () => observation,
    });
    expect(
      (await cases.find((c) => c.id.endsWith(":csv"))!.run(signal())).status,
    ).toBe("skipped");
    observation.xlsx = new Uint8Array([0, 1, 2, 3]);
    expect(
      (await cases.find((c) => c.id.endsWith(":xlsx"))!.run(signal())).status,
    ).toBe("fail");
  });
});
