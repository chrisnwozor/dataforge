import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardAttributeSlicer, DashboardPrintTable, DashboardText, DashboardTileContent, dashboardFilterSummary, dashboardTileExploreHref } from "@/components/dashboards/tile-content";
import { DashboardTileSettings } from "@/components/dashboards/tile-settings";
import { createEmptyView } from "@/lib/explore/config";
import { decodeViewConfig } from "@/lib/explore/url";
import { kpiTileSchema, type ChartTile, type KpiTile } from "@/lib/dashboards/schema";
import type { SemanticModel } from "@/lib/semantic/types";
import type { QueryResult } from "@/lib/semantic/query/types";

const projectId = "11111111-1111-4111-8111-111111111111";
const model: SemanticModel = {
  projectId, version: "one", factTableId: "fact", hierarchies: [],
  tables: [
    { id: "fact", name: "fact_sales", schema: "dw", sqlName: "fact_sales", kind: "fact", keyColumnId: "fact:key", columns: [
      { id: "fact:key", tableId: "fact", name: "Fact Key", sqlName: "fact_key", type: "number", role: "key" },
      { id: "fact:sales", tableId: "fact", name: "Sales", sqlName: "sales", type: "number", role: "measure-source" },
      { id: "fact:product", tableId: "fact", name: "Product Key", sqlName: "product_key", type: "number", role: "key" },
    ] },
    { id: "product", name: "dim_product", schema: "dw", sqlName: "dim_product", kind: "dimension", keyColumnId: "product:key", columns: [
      { id: "product:key", tableId: "product", name: "Product Key", sqlName: "product_key", type: "number", role: "key" },
      { id: "category", tableId: "product", name: "Category", sqlName: "category", type: "string", role: "attribute", distinctCount: 2000 },
    ] },
  ],
  relationships: [{ id: "product-link", fromTableId: "fact", fromColumnId: "fact:product", toTableId: "product", toColumnId: "product:key", cardinality: "many-to-one" }],
  measures: [
    { id: "sales", name: "Sales", expression: "SUM(fact_sales[Sales])", format: "currency", folder: "", description: "", isAuto: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "yoy", name: "Sales YoY %", expression: "DIVIDE([Sales], [Sales])", format: "percent", folder: "", description: "", isAuto: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
};
const datedModel: SemanticModel = {
  ...model,
  date: { tableId: "date", dateColumnId: "date:date", keyColumnId: "date:key", factColumnId: "fact:date" },
  tables: [...model.tables, { id: "date", name: "dim_date", schema: "dw", sqlName: "dim_date", kind: "dimension", keyColumnId: "date:key", columns: [
    { id: "date:date", tableId: "date", name: "Date", sqlName: "date", type: "date", role: "attribute" },
  ] }],
};
const base = { id: "tile", x: 0, y: 0, w: 6, h: 4, title: "Sales summary", subtitle: "", numberFormat: "auto" as const, showLegend: true };
const kpi: KpiTile = { ...base, type: "kpi", measure: "sales", comparisonMeasure: "yoy" };
const view = { ...createEmptyView(), viz: "bar" as const, rows: [{ table: "product", column: "category" }], values: ["sales"] };
const chart: ChartTile = { ...base, type: "chart", source: { kind: "inline", config: view } };
const result: QueryResult = { columns: [{ key: "m0", name: "Sales", type: "number", role: "measure" }, { key: "m1", name: "Sales YoY %", type: "number", role: "measure" }], rows: [{ m0: 1200.5, m1: 0.125 }], rowCount: 1, truncated: false, elapsedMs: 12, fromCache: false, sql: "SELECT generated_only" };
const comparison = { measure: "yoy", label: "2024 vs 2023", result: { ...result, columns: [result.columns[1]], rows: [{ m1: 0.1253 }] } };
afterEach(() => vi.unstubAllGlobals());

describe("dashboard tile rendering", () => {
  it("renders a small markdown grammar while escaping HTML and leaving unsafe links inert", () => {
    const html = renderToStaticMarkup(createElement(DashboardText, { content: "# Overview\n\n**Revenue** and *growth* with `Sales`.\n\n- First\n- Second\n\n<script>alert('x')</script>\n<img src=x onerror=alert(1)>\n\n[Run](javascript:alert(1))" }));
    expect(html).toContain("<h3>Overview</h3>");
    expect(html).toContain("<strong>Revenue</strong>");
    expect(html).toContain("<em>growth</em>");
    expect(html).toContain("<code>Sales</code>");
    expect(html).toContain("<ul><li>First</li><li>Second</li></ul>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<script|<img|href=|dangerouslySetInnerHTML/);
  });

  it("labels the separate latest-period comparison and ignores an all-range YoY value", () => {
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: kpi, model: datedModel, views: [], state: { status: "success", result: { ...result, rows: [{ m0: 1200.5, m1: 0.5302 }] }, kpi: { periodLabel: "All time", comparison }, elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(html).toContain("$1,200.50");
    expect(html).toContain("+12.53%");
    expect(html).toContain("2024 vs 2023");
    expect(html).not.toContain("53.02%");
    expect(html).toContain("Sales YoY %");
    expect(html).toContain("All time · Current dashboard filter context");
  });

  it("honors a KPI override without changing comparison formatting and handles null results", () => {
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: { ...kpi, numberFormat: "number" }, model: datedModel, views: [], state: { status: "success", result: { ...result, rows: [{ m0: 2022 }] }, kpi: { periodLabel: "2024", comparison: { ...comparison, result: { ...comparison.result, rows: [{ m1: null }] } } }, elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(html).toContain("2,022");
    expect(html).not.toContain("$2,022");
    expect(html).toContain("—");
    expect(html).toContain("2024 · Current dashboard filter context");
  });

  it("hides comparisons without a date dimension and never renders legacy unbounded comparison results", () => {
    const noDate = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: kpi, model, views: [], state: { status: "success", result, kpi: { comparison }, elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(noDate).not.toContain("Sales YoY %");
    expect(noDate).not.toContain("2024 vs 2023");
    const legacy = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: kpi, model: datedModel, views: [], state: { status: "success", result, elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(legacy).not.toContain("12.5%");
    expect(legacy).not.toContain("Sales YoY %");
  });

  it("formats SQL driver count strings with thousands separators and preserves numeric comparisons", () => {
    const counts: SemanticModel = { ...datedModel, measures: [{ ...model.measures[0], id: "count", name: "Row Count", expression: "COUNT_BIG(*)", format: "number" }, model.measures[1]] };
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: { ...kpi, measure: "count" }, model: counts, views: [], state: { status: "success", result: { ...result, columns: [{ ...result.columns[0], name: "Row Count" }], rows: [{ m0: "2000" }] }, kpi: { periodLabel: "All time", comparison: { ...comparison, result: { ...comparison.result, rows: [{ m1: "0.1253" }] } } }, elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(html).toContain("2,000");
    expect(html).toContain("+12.53%");
  });

  it("preserves the old KPI period default and exposes explicit period settings", () => {
    expect(kpiTileSchema.parse(kpi).period).toBeUndefined();
    expect(kpiTileSchema.parse({ ...kpi, period: "latestQuarter" }).period).toBe("latestQuarter");
    expect(kpiTileSchema.safeParse({ ...kpi, period: "lastWeek" }).success).toBe(false);
    const settings = renderToStaticMarkup(createElement(DashboardTileSettings, { tile: kpi, model: datedModel, views: [], onChange: () => {} }));
    expect(settings).toContain('aria-label="KPI period: All time"');
    expect(settings).toContain("latest complete year, quarter, or month");
    expect(settings).toContain("replace calendar filters");
    const quarter = renderToStaticMarkup(createElement(DashboardTileSettings, { tile: { ...kpi, period: "latestQuarter" }, model: datedModel, views: [], onChange: () => {} }));
    expect(quarter).toContain('aria-label="KPI period: Latest quarter"');
    const noDate = renderToStaticMarkup(createElement(DashboardTileSettings, { tile: kpi, model, views: [], onChange: () => {} }));
    expect(noDate).toContain("Period selection and time comparisons require a date dimension");
  });

  it("keeps text and missing-view failures usable without querying or a semantic connection", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const text = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: { ...base, type: "text", content: "**A note**" }, model: null, views: [], state: { status: "idle", elapsedMs: 0 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(text).toContain("<strong>A note</strong>");
    const missing = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: { ...chart, source: { kind: "view", viewId: projectId } }, model, views: [], state: { status: "error", error: "Missing view", elapsedMs: 0 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(missing).toContain("This saved view is unavailable.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not eagerly fetch values even for a visible high-cardinality slicer", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(createElement(DashboardAttributeSlicer, { projectId, model, attribute: { table: "product", column: "category" }, filters: [], onChange: () => {} }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("All values");
    expect(html).not.toContain('role="dialog"');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows pending and error states per tile without removing the previous KPI value", () => {
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: kpi, model, views: [], state: { status: "loading", result, error: "A previous attempt failed.", elapsedMs: 4100 }, filters: [], onFilterChange: () => {}, onRetry: () => {}, onCancel: () => {} }));
    expect(html).toContain("Waiting for the database… · 4.1 s");
    expect(html).toContain("Cancel tile");
    expect(html).toContain("Retry tile");
    expect(html).toContain("$1,200.50");
  });

  it("keeps a previous KPI paired with its original measure when an edit fails", () => {
    const changedModel: SemanticModel = { ...model, measures: [...model.measures, { ...model.measures[0], id: "profit", name: "Profit" }] };
    const previousConfig = { ...createEmptyView(), viz: "kpi" as const, values: ["sales", "yoy"] };
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: { ...kpi, measure: "profit", comparisonMeasure: undefined }, model: changedModel, views: [], state: { status: "error", result, config: previousConfig, error: "Try again.", elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onRetry: () => {} }));
    expect(html).toContain("Sales");
    expect(html).toContain("$1,200.50");
    expect(html).not.toContain(">Profit<");
    expect(html).toContain("Previous query context");
  });

  it("disables member actions on retained chart data after a failed filter change", () => {
    const grouped: QueryResult = { ...result, columns: [{ key: "a0", name: "Category", type: "string", role: "attribute" }, result.columns[0]], rows: [{ a0: "Furniture", m0: 1200.5 }] };
    const html = renderToStaticMarkup(createElement(DashboardTileContent, { projectId, tile: chart, model, views: [], state: { status: "error", result: grouped, config: view, error: "Try again.", elapsedMs: 12 }, filters: [], onFilterChange: () => {}, onMemberClick: () => {}, onRetry: () => {} }));
    expect(html).toContain("Previous result");
    expect(html).not.toContain("Explore member");
  });

  it("prints a bounded table excerpt with formatted labels instead of virtual spacers or buttons", () => {
    const large: QueryResult = { ...result, columns: [{ key: "a0", name: "Year", type: "number", role: "attribute" }, result.columns[0]], rows: Array.from({ length: 50_000 }, () => ({ a0: 2022, m0: 1200.5 })), rowCount: 50_000 };
    const html = renderToStaticMarkup(createElement(DashboardPrintTable, { result: large, config: { ...view, viz: "table" }, model }));
    expect(html).toContain("First 15 of 50,000 rows");
    expect(html.match(/<tr>/g)).toHaveLength(16);
    expect(html).toContain("2022");
    expect(html).not.toContain("2,022");
    expect(html).toContain("$1,200.50");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-hidden");
    expect(html.length).toBeLessThan(5000);
  });

  it("provides settings without a connection and escapes arbitrary text content", () => {
    const html = renderToStaticMarkup(createElement(DashboardTileSettings, { tile: { ...base, type: "text", content: "<script>alert(1)</script>" }, model: null, views: [], onChange: () => {} }));
    expect(html).toContain("Tile settings");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("tile Explore links and filter summaries", () => {
  it("encodes the current tile formatting and only connected filters into Explore", () => {
    const href = dashboardTileExploreHref(projectId, { ...chart, title: "Current Sales", numberFormat: "decimals", showLegend: false }, [], [
      { attribute: { table: "product", column: "category" }, op: "eq", value: "Furniture" },
      { attribute: { table: "unconnected", column: "x" }, op: "eq", value: "should not leak into query" },
    ], model)!;
    const decoded = decodeViewConfig(new URL(href, "http://localhost").searchParams.get("config")!);
    expect(decoded?.values).toEqual(["sales"]);
    expect(decoded?.options).toMatchObject({ title: "Current Sales", numberFormat: "decimals", showLegend: false });
    expect(decoded?.filters).toEqual([{ attribute: { table: "product", column: "category" }, op: "eq", value: "Furniture" }]);
    expect(view.filters).toEqual([]);
    expect(dashboardTileExploreHref(projectId, { ...base, type: "text", content: "note" }, [])).toBeNull();
  });

  it("summarizes all, inclusion, exclusion, NULL, and range filters", () => {
    const attribute = { table: "product", column: "category" };
    expect(dashboardFilterSummary([])).toBe("All values");
    expect(dashboardFilterSummary([{ attribute, op: "in", values: [] }])).toBe("No values selected");
    expect(dashboardFilterSummary([{ attribute, op: "in", values: ["a", "b"] }])).toBe("2 selected");
    expect(dashboardFilterSummary([{ attribute, op: "notIn", values: ["a"] }])).toBe("All except 1 values");
    expect(dashboardFilterSummary([{ attribute, op: "isNull" }])).toBe("Empty values");
    expect(dashboardFilterSummary([{ attribute, op: "gte", value: 2022 }, { attribute, op: "lte", value: 2024 }], { name: "Year", type: "number" })).toBe("2022 → 2024");
  });
});
