import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createEmptyDashboard,
  type SavedDashboard,
} from "@/lib/dashboards/schema";
import { createEmptyView } from "@/lib/explore/config";
import type {
  QueryResult,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import {
  collectDashboardObservation,
  createDashboardChecks,
  independentLatestPeriod,
  type DashboardObservation,
} from "@/lib/verify/dashboards";
import type { EngineExecutor, ReferenceExecutor } from "@/lib/verify/types";

function model(): SemanticModel {
  const time = "2024-01-01T00:00:00Z";
  return {
    projectId: randomUUID(),
    version: "dash-v1",
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
            id: "product-fk",
            tableId: "fact",
            name: "ProductKey",
            sqlName: "ProductKey",
            type: "number",
            role: "key",
          },
          {
            id: "date-fk",
            tableId: "fact",
            name: "DateKey",
            sqlName: "DateKey",
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
      {
        id: "date",
        name: "dim_date",
        sqlName: "dim_date",
        schema: "dw",
        kind: "dimension",
        keyColumnId: "date:key",
        columns: [
          {
            id: "date:key",
            tableId: "date",
            name: "DateKey",
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
          {
            id: "date:year",
            tableId: "date",
            name: "Year",
            sqlName: "Year",
            type: "number",
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
      {
        id: "date-rel",
        fromTableId: "fact",
        fromColumnId: "date-fk",
        toTableId: "date",
        toColumnId: "date:key",
        cardinality: "many-to-one",
      },
    ],
    date: {
      tableId: "date",
      dateColumnId: "date:date",
      keyColumnId: "date:key",
      factColumnId: "date-fk",
    },
    measures: [
      {
        id: "sales",
        name: "Sales",
        expression: "SUM('fact_sales'[Sales])",
        format: "currency",
        folder: "",
        description: "",
        isAuto: true,
        createdAt: time,
        updatedAt: time,
      },
      {
        id: "sales-ly",
        name: "Sales LY",
        expression: "SAMEPERIODLASTYEAR([Sales])",
        format: "currency",
        folder: "",
        description: "",
        isAuto: true,
        createdAt: time,
        updatedAt: time,
      },
      {
        id: "yoy",
        name: "Sales YoY %",
        expression: "DIVIDE([Sales] - [Sales LY], [Sales LY])",
        format: "percent",
        folder: "",
        description: "",
        isAuto: true,
        createdAt: time,
        updatedAt: time,
      },
    ],
    hierarchies: [],
  };
}
const category = { table: "product", column: "category" };
function dashboard(projectId: string, kpi = false): SavedDashboard {
  const empty = createEmptyDashboard("Review dashboard"),
    view = createEmptyView();
  return {
    ...empty,
    id: randomUUID(),
    projectId,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    layout: {
      version: 1,
      tiles: [
        kpi
          ? {
              id: "tile",
              type: "kpi",
              x: 0,
              y: 0,
              w: 3,
              h: 5,
              title: "Sales",
              subtitle: "",
              numberFormat: "auto",
              showLegend: true,
              measure: "sales",
              comparisonMeasure: "yoy",
              period: "all",
            }
          : {
              id: "tile",
              type: "chart",
              x: 0,
              y: 0,
              w: 6,
              h: 10,
              title: "Sales chart",
              subtitle: "",
              numberFormat: "auto",
              showLegend: true,
              source: {
                kind: "inline",
                config: {
                  ...view,
                  rows: [category],
                  values: ["sales"],
                  viz: "bar",
                },
              },
            },
      ],
    },
  };
}
function result(
  values: QueryResult["rows"],
  columns: QueryResult["columns"],
): QueryResult {
  return {
    columns,
    rows: values,
    rowCount: values.length,
    truncated: false,
    elapsedMs: 1,
    fromCache: false,
    sql: "SELECT actual_dashboard",
  };
}
const salesColumn = {
  key: "m0",
  name: "Sales",
  type: "number" as const,
  role: "measure" as const,
};
const chartResult = () =>
  result(
    [
      { a0: "A", m0: 100 },
      { a0: "B", m0: 200 },
    ],
    [
      { key: "a0", name: "Category", type: "string", role: "attribute" },
      salesColumn,
    ],
  );
const currentSales = 656764.29,
  previousSales = 583648.73,
  expectedYoy = (currentSales - previousSales) / previousSales;
const reference: ReferenceExecutor = async (query) => {
  const date = query.columns.some(
    (column) => column.role === "attribute" && column.type === "date",
  );
  return [
    Object.fromEntries(
      query.columns.map((column) => [
        column.key,
        column.role === "attribute"
          ? date
            ? "2024-12-30"
            : "A"
          : query.params.some((p) => p.value === "2023-01-01")
            ? previousSales
            : currentSales,
      ]),
    ),
  ] as Record<string, QueryValue>[];
};
const signal = () => new AbortController().signal;
const kpiObservation = (
  value = expectedYoy,
  label = "2024 vs 2023",
): DashboardObservation => ({
  tile: {
    result: result([{ m0: currentSales + previousSales }], [salesColumn]),
    comparison: {
      result: result(
        [{ m0: value }],
        [{ ...salesColumn, name: "Sales YoY %" }],
      ),
      label,
      measure: "yoy",
    },
  },
});

describe("independent latest-period calculations", () => {
  it("selects historical 2024 vs 2023 from a December 30 watermark and recomputes the stated 12.53% example", () => {
    const period = independentLatestPeriod("2024-12-30", "year", "2026-10-29");
    expect(period).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
      previousStart: "2023-01-01",
      previousEnd: "2023-12-31",
      label: "2024",
      previousLabel: "2023",
    });
    expect(Number((expectedYoy * 100).toFixed(2))).toBe(12.53);
  });
  it("uses the preceding closed current year/quarter/month and calendar leap days", () => {
    expect(
      independentLatestPeriod("2026-10-27", "year", "2026-10-29")?.label,
    ).toBe("2025");
    expect(
      independentLatestPeriod("2024-02-12", "month", "2024-02-15"),
    ).toMatchObject({
      label: "Jan 2024",
      start: "2024-01-01",
      end: "2024-01-31",
    });
    expect(
      independentLatestPeriod("2024-02-29", "month", "2024-03-01"),
    ).toMatchObject({ label: "Feb 2024", end: "2024-02-29" });
    expect(
      independentLatestPeriod("2024-06-29", "quarter", "2025-01-01")?.label,
    ).toBe("Q2 2024");
    expect(
      independentLatestPeriod("nonsense", "year", "2024-01-01"),
    ).toBeNull();
    expect(
      independentLatestPeriod("2024-02-30", "month", "2026-01-01"),
    ).toBeNull();
  });
  it("flags the whole-range comparison bug and an incorrect period label independently", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId, true);
    const checks = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      asOfDate: "2026-10-29",
      observeDashboard: async () => kpiObservation(0.5302),
    });
    expect(
      (await checks.find((c) => c.id.endsWith(":period"))!.run(signal()))
        .status,
    ).toBe("fail");
    const correct = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      asOfDate: "2026-10-29",
      observeDashboard: async () => kpiObservation(),
    });
    const outcome = await correct
      .find((c) => c.id.endsWith(":period"))!
      .run(signal());
    expect(outcome.status).toBe("pass");
    expect(outcome.referenceSql).toContain("SELECT");
    expect(outcome.explanation).toContain("(current - previous) / previous");
    const wrongLabel = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      asOfDate: "2026-10-29",
      observeDashboard: async () => kpiObservation(expectedYoy, "All time"),
    });
    expect(
      (await wrongLabel.find((c) => c.id.endsWith(":period"))!.run(signal()))
        .status,
    ).toBe("fail");
  });
  it("skips period comparisons without a date model or unambiguous prior-period measure", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId, true);
    delete semantic.date;
    const check = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      observeDashboard: async () => kpiObservation(),
    }).find((c) => c.id.endsWith(":period"))!;
    expect((await check.run(signal())).status).toBe("skipped");
  });
});

describe("dashboard batch vs individual checks", () => {
  it("reconciles typed member tuples, ignores order/SQL aliases, and passes tolerance differences", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId),
      batch = chartResult();
    batch.columns[0].key = "categoryAlias";
    batch.rows = [
      { categoryAlias: "B", m0: 200.005 },
      { categoryAlias: "A", m0: 100 },
    ];
    const checks = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      observeDashboard: async () => ({ tile: { result: batch } }),
    });
    const outcome = await checks[0].run(signal());
    expect(outcome.status).toBe("pass");
    expect(Math.abs(outcome.difference ?? 0)).toBeCloseTo(0.005, 8);
  });
  it("fails missing/duplicate members, changed values and tile errors", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId);
    for (const batch of [
      result(
        [{ a0: "A", m0: 999 }],
        [
          { key: "a0", name: "Category", type: "string", role: "attribute" },
          salesColumn,
        ],
      ),
      result(
        [
          { a0: "A", m0: 100 },
          { a0: "A", m0: 200 },
        ],
        [
          { key: "a0", name: "Category", type: "string", role: "attribute" },
          salesColumn,
        ],
      ),
    ]) {
      const check = createDashboardChecks({
        model: semantic,
        dashboards: [saved],
        engine: async () => chartResult(),
        reference,
        observeDashboard: async () => ({ tile: { result: batch } }),
      })[0];
      expect((await check.run(signal())).status).toBe("fail");
    }
    const error = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      observeDashboard: async () => ({ tile: { error: "Tile failed" } }),
    })[0];
    expect(await error.run(signal())).toMatchObject({
      status: "fail",
      explanation: "Tile failed",
    });
  });
  it("applies connected dashboard filters independently and does not send disconnected filters", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId);
    saved.filters.items = [
      { attribute: category, op: "eq", value: "A" },
      {
        attribute: { table: "unknown", column: "missing" },
        op: "eq",
        value: "secret",
      },
    ];
    const engine = vi.fn<EngineExecutor>(async () => chartResult());
    const check = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine,
      reference,
      observeDashboard: async () => ({ tile: { result: chartResult() } }),
    })[0];
    await check.run(signal());
    expect(engine.mock.calls[0][0].filters).toEqual([
      { attribute: category, op: "eq", value: "A" },
    ]);
  });
  it("skips empty dashboards/truncated results and propagates cancellation", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId);
    const empty = createDashboardChecks({
      model: semantic,
      dashboards: [],
      engine: async () => chartResult(),
      reference,
    })[0];
    expect((await empty.run(signal())).status).toBe("skipped");
    const partial = chartResult();
    partial.truncated = true;
    const check = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine: async () => chartResult(),
      reference,
      observeDashboard: async () => ({ tile: { result: partial } }),
    })[0];
    expect((await check.run(signal())).status).toBe("skipped");
    const controller = new AbortController();
    controller.abort();
    await expect(check.run(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("actual dashboard controller observation adapter", () => {
  it("uses a fresh local cache, one pending tile and live engine requests", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId);
    let active = 0,
      peak = 0;
    const seen: SemanticQuery[] = [];
    const engine: EngineExecutor = async (query) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(query);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return chartResult();
    };
    const observed = await collectDashboardObservation(
      saved,
      semantic,
      [],
      engine,
      signal(),
      { asOfDate: "2026-10-29", lastSuccessfulRunId: "load-v1" },
    );
    expect(observed.tile.result?.rows).toEqual(chartResult().rows);
    expect(peak).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].cache).toBe("bypass");
  });

  it("observes the actual KPI path and reconciles its latest-year comparison against separate reference arithmetic", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId, true);
    const engine: EngineExecutor = async (query) => {
      if (query.rows.some((r) => r.table === "date"))
        return result(
          [{ date: "2024-12-30", m0: currentSales }],
          [
            { key: "date", name: "Date", type: "date", role: "attribute" },
            salesColumn,
          ],
        );
      if (query.measures[0] === "yoy")
        return result(
          [{ m0: expectedYoy }],
          [{ ...salesColumn, name: "Sales YoY %" }],
        );
      return result([{ m0: currentSales + previousSales }], [salesColumn]);
    };
    const checks = createDashboardChecks({
      model: semantic,
      dashboards: [saved],
      engine,
      reference,
      asOfDate: "2026-10-29",
    });
    expect((await checks[0].run(signal())).status).toBe("pass");
    expect(
      (await checks.find((c) => c.id.endsWith(":period"))!.run(signal()))
        .status,
    ).toBe("pass");
  });
  it("disposes and rejects on abort and returns actual tile errors without making them pass", async () => {
    const semantic = model(),
      saved = dashboard(semantic.projectId);
    const controller = new AbortController();
    const pending = collectDashboardObservation(
      saved,
      semantic,
      [],
      async () => new Promise<QueryResult>(() => {}),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const observed = await collectDashboardObservation(
      saved,
      semantic,
      [],
      async () => {
        throw new Error("Driver offline");
      },
      signal(),
    );
    expect(observed.tile.error).toBe("Driver offline");
  });
});
