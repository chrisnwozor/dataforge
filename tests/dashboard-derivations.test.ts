import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyView, type ViewConfig } from "@/lib/explore/config";
import { generateStarterDashboard } from "@/lib/dashboards/starter";
import { affectedTileIds, applicableFilters, attributeAppliesToTile, mergeDashboardFilters, resolveTileView, toggleCrossFilter } from "@/lib/dashboards/filters";
import { tileCacheKey } from "@/lib/dashboards/cache";
import { dashboardDocumentSchema, type ChartTile, type DashboardTile } from "@/lib/dashboards/schema";
import type { AttributeRef, QueryFilter } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { createSuperstoreSemanticFixture } from "./fixtures/superstore-semantic";

let model: SemanticModel;
beforeAll(async () => { model = await createSuperstoreSemanticFixture(); });
const base = { x: 0, y: 0, w: 6, h: 4, title: "Sales", subtitle: "", numberFormat: "auto" as const, showLegend: true };
const attribute = (name: string): AttributeRef => {
  const table = model.tables.find((entry) => entry.kind === "dimension" && entry.columns.some((column) => column.name === name))!;
  return { table: table.id, column: table.columns.find((column) => column.name === name)!.id };
};
const sales = () => model.measures.find((measure) => measure.name === "Sales")!;
const view = (): ViewConfig => ({ ...createEmptyView(), viz: "bar", values: [sales().id], rows: [attribute("Year")] });
const chart = (config = view()): ChartTile => ({ ...base, id: "chart", type: "chart", source: { kind: "inline", config } });

describe("metadata-only starter dashboards", () => {
  it("is deterministic and generates four additive KPIs, a calendar trend, small business categories and slicers for Superstore", () => {
    const result = generateStarterDashboard(model);
    expect(generateStarterDashboard(structuredClone(model))).toEqual(result);
    expect(dashboardDocumentSchema.safeParse(result).success).toBe(true);
    const kpis = result.layout.tiles.filter((tile) => tile.type === "kpi");
    expect(kpis).toHaveLength(4);
    expect(kpis.map((tile) => model.measures.find((measure) => measure.id === tile.measure)!.name)).toEqual(["Sales", "Quantity", "Profit", "Row Count"]);
    expect(model.measures.find((measure) => measure.id === kpis[0].comparisonMeasure)?.name).toBe("Sales YoY %");
    expect(kpis[3].comparisonMeasure).toBeUndefined();
    const trend = result.layout.tiles.find((tile) => tile.id === "starter-trend")!;
    expect(trend.type).toBe("chart");
    if (trend.type === "chart" && trend.source.kind === "inline") {
      expect(trend.source.config.viz).toBe("line");
      expect(trend.source.config.rows).toEqual([attribute("Year")]);
    }
    const bars = result.layout.tiles.filter((tile) => tile.type === "chart" && tile.id.startsWith("starter-bar"));
    expect(bars).toHaveLength(3);
    expect(bars.every((tile) => tile.h === trend.h)).toBe(true);
    expect(bars.map((tile) => tile.title)).toEqual(["Sales by Segment", "Sales by Category", "Sales by Region"]);
    for (const tile of bars) if (tile.type === "chart" && tile.source.kind === "inline") {
      const ref = tile.source.config.rows[0];
      const table = model.tables.find((entry) => entry.id === ref.table)!;
      const column = table.columns.find((entry) => entry.id === ref.column)!;
      expect(table.id).not.toBe(model.date?.tableId);
      expect(column.distinctCount).toBeLessThanOrEqual(50);
    }
    const slicers = result.layout.tiles.filter((tile) => tile.type === "slicer");
    expect(slicers.map((tile) => tile.title)).toEqual(["Segment", "Category"]);
  });

  it("chooses Month when Year has fewer than three values, and retains Year when its count is unknown", () => {
    const sparse = structuredClone(model);
    const year = sparse.tables.find((table) => table.id === sparse.date?.tableId)!.columns.find((column) => column.name === "Year")!;
    year.distinctCount = 2;
    const month = generateStarterDashboard(sparse).layout.tiles.find((tile) => tile.id === "starter-trend")!;
    expect(month.title).toBe("Sales by Month");
    if (month.type !== "chart" || month.source.kind !== "inline") throw new Error("Expected an inline monthly chart.");
    expect(month.source.config.rows).toEqual([attribute("Year"), attribute("Month")]);
    expect(month.source.config.sort).toEqual([{ ref: attribute("Year"), dir: "asc" }, { ref: attribute("Month"), dir: "asc" }]);
    const Januarys = [{ Year: 2022, Month: 1, Sales: 10 }, { Year: 2023, Month: 1, Sales: 20 }];
    const context = (row: typeof Januarys[number]) => month.source.kind === "inline" ? month.source.config.rows.map((ref) => row[ref.column === year.id ? "Year" : "Month"]) : [];
    expect(new Set(Januarys.map((row) => JSON.stringify(context(row)))).size).toBe(2);
    year.distinctCount = 1;
    const singleYear = generateStarterDashboard(sparse).layout.tiles.find((tile) => tile.id === "starter-trend")!;
    if (singleYear.type === "chart" && singleYear.source.kind === "inline") expect(singleYear.source.config.rows).toEqual([attribute("Year"), attribute("Month")]);
    delete year.distinctCount;
    expect(generateStarterDashboard(sparse).layout.tiles.find((tile) => tile.id === "starter-trend")!.title).toBe("Sales by Year");
    const calendar = sparse.tables.find((table) => table.id === sparse.date?.tableId)!;
    calendar.columns = calendar.columns.filter((column) => column.id !== year.id);
    const noYear = generateStarterDashboard(sparse).layout.tiles.find((tile) => tile.id === "starter-trend")!;
    if (noYear.type === "chart" && noYear.source.kind === "inline") expect(noYear.source.config.rows).toEqual([attribute("Month")]);
  });

  it("omits time intelligence for a model without dates and never guesses large/unknown bar cardinalities", () => {
    const withoutDate = structuredClone(model);
    withoutDate.tables = withoutDate.tables.filter((table) => table.id !== withoutDate.date?.tableId);
    withoutDate.relationships = withoutDate.relationships.filter((relationship) => relationship.toTableId !== withoutDate.date?.tableId);
    delete withoutDate.date;
    const result = generateStarterDashboard(withoutDate);
    expect(result.layout.tiles.some((tile) => tile.id === "starter-trend")).toBe(false);
    expect(result.layout.tiles.filter((tile) => tile.type === "kpi").every((tile) => tile.comparisonMeasure === undefined)).toBe(true);
    for (const table of withoutDate.tables.filter((entry) => entry.kind === "dimension"))
      for (const column of table.columns) column.distinctCount = column.name === "Region" ? 51 : undefined;
    const noSmallBars = generateStarterDashboard(withoutDate);
    expect(noSmallBars.layout.tiles.some((tile) => tile.id.startsWith("starter-bar"))).toBe(false);
    expect(noSmallBars.layout.tiles.filter((tile) => tile.type === "slicer").map((tile) => tile.title)).toEqual(["Region"]);
  });

  it("falls back to known calendar categories only when no business dimension exists", () => {
    const calendarOnly = structuredClone(model);
    calendarOnly.tables = calendarOnly.tables.filter((table) => table.kind === "fact" || table.id === calendarOnly.date?.tableId);
    calendarOnly.relationships = calendarOnly.relationships.filter((relationship) => relationship.toTableId === calendarOnly.date?.tableId);
    const result = generateStarterDashboard(calendarOnly);
    expect(result.layout.tiles.filter((tile) => tile.type === "slicer")).toHaveLength(2);
    expect(result.layout.tiles.some((tile) => tile.id === "starter-bar-1")).toBe(true);
  });

  it("creates a useful text placeholder when measures are absent", () => {
    const empty = { ...model, measures: [] };
    const result = generateStarterDashboard(empty);
    expect(result.layout.tiles.some((tile) => tile.type === "text")).toBe(true);
    expect(result.layout.tiles.some((tile) => tile.type === "chart" || tile.type === "kpi")).toBe(false);
    expect(dashboardDocumentSchema.safeParse(result).success).toBe(true);
  });

  it("bounds generated titles for legal long semantic display names", () => {
    const renamed = structuredClone(model);
    renamed.measures.find((measure) => measure.name === "Sales")!.name = "A".repeat(128);
    renamed.tables.find((table) => table.columns.some((column) => column.name === "Segment"))!.columns.find((column) => column.name === "Segment")!.name = "B".repeat(128);
    const result = generateStarterDashboard(renamed);
    expect(result.layout.tiles.every((tile) => tile.title.length <= 200)).toBe(true);
    expect(dashboardDocumentSchema.safeParse(result).success).toBe(true);
  });
});

describe("dashboard filter contexts", () => {
  it("applies a shared dimension even when the tile groups by another dimension", () => {
    const region = attribute("Region");
    const filter: QueryFilter = { attribute: region, op: "eq", value: "East" };
    expect(attributeAppliesToTile(chart(), model, region)).toBe(true);
    expect(applicableFilters(chart(), model, [filter])).toEqual([filter]);
    const text: DashboardTile = { ...base, id: "text", type: "text", content: "Hello" };
    const slicer: DashboardTile = { ...base, id: "slicer", type: "slicer", attribute: region };
    expect(affectedTileIds(model, [chart(), text, slicer], filter)).toEqual(["chart"]);
  });

  it("rejects disconnected/unknown dimensions and canonicalizes known references", () => {
    const region = attribute("Region");
    const disconnected = { ...model, relationships: model.relationships.filter((entry) => entry.toTableId !== region.table) };
    expect(attributeAppliesToTile(chart(), disconnected, region)).toBe(false);
    expect(applicableFilters(chart(), model, [{ attribute: { table: "missing", column: "missing" }, op: "eq", value: "x" }])).toEqual([]);
    const table = model.tables.find((entry) => entry.id === region.table)!;
    expect(applicableFilters(chart(), model, [{ attribute: { table: table.name, column: "Region" }, op: "eq", value: "West" }])[0].attribute).toEqual(region);
    const colliding = structuredClone(model);
    colliding.tables.find((entry) => entry.id === region.table)!.columns.push({ id: "other", tableId: region.table, name: region.column, sqlName: "other", type: "string", role: "attribute" });
    expect(attributeAppliesToTile(chart(), colliding, region)).toBe(true);
  });

  it("resolves saved views and both KPI measures without accepting broken tile references", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const saved: ChartTile = { ...base, id: "saved", type: "chart", source: { kind: "view", viewId: id } };
    expect(resolveTileView(saved)).toBeNull();
    expect(attributeAppliesToTile(saved, model, attribute("Region"))).toBe(false);
    expect(resolveTileView(saved, [{ id, config: view() }])).toEqual(view());
    const comparison = model.measures.find((measure) => measure.name === "Sales YoY %")!.id;
    const kpi: DashboardTile = { ...base, id: "kpi", type: "kpi", measure: sales().id, comparisonMeasure: comparison };
    expect(resolveTileView(kpi)?.values).toEqual([sales().id, comparison]);
    expect(attributeAppliesToTile(kpi, model, attribute("Region"))).toBe(true);
    expect(attributeAppliesToTile({ ...kpi, measure: "missing" }, model, attribute("Region"))).toBe(false);
  });

  it("toggles cross-filter members and handles null without emitting an invalid comparison", () => {
    const ref = attribute("Category"), other = attribute("Region");
    const original: QueryFilter[] = [{ attribute: other, op: "eq", value: "East" }];
    const first = toggleCrossFilter(original, ref, "Furniture");
    expect(first).toEqual([...original, { attribute: ref, op: "eq", value: "Furniture" }]);
    expect(toggleCrossFilter(first, ref, "Furniture")).toEqual(original);
    const second = toggleCrossFilter(first, ref, "Technology");
    expect(second.at(-1)).toEqual({ attribute: ref, op: "eq", value: "Technology" });
    const nil = toggleCrossFilter(original, ref, null);
    expect(nil.at(-1)).toEqual({ attribute: ref, op: "isNull" });
    expect(toggleCrossFilter(nil, ref, null)).toEqual(original);
    expect(original).toHaveLength(1);
  });

  it("intersects view filters with dashboard filters and deduplicates identical constraints", () => {
    const ref = attribute("Category");
    const filter: QueryFilter = { attribute: ref, op: "in", values: ["Furniture", "Technology"] };
    const range: QueryFilter = { attribute: attribute("Year"), op: "gte", value: 2022 };
    expect(mergeDashboardFilters([filter], [{ ...filter, values: ["Technology", "Furniture"] }, range])).toEqual([filter, range]);
    expect(mergeDashboardFilters([{ attribute: ref, op: "eq", value: "Furniture" }], [{ attribute: ref, op: "eq", value: "Technology" }])).toHaveLength(2);
  });
});

describe("tile cache identities", () => {
  const key = (overrides: Partial<Parameters<typeof tileCacheKey>[0]> = {}) => tileCacheKey({ projectId: model.projectId, modelVersion: model.version, lastSuccessfulRunId: "run-1", tile: chart(), filters: [], viewConfig: view(), ...overrides });
  it("includes semantic/run/tile/filter context while layout moves remain cache hits", () => {
    const original = key();
    expect(key({ tile: { ...chart(), x: 6, y: 10, w: 3, h: 2 } })).toBe(original);
    expect(key({ modelVersion: "next" })).not.toBe(original);
    expect(key({ lastSuccessfulRunId: "run-2" })).not.toBe(original);
    expect(key({ projectId: "another" })).not.toBe(original);
    expect(key({ tile: { ...chart(), title: "Renamed" } })).not.toBe(original);
    expect(key({ filters: [{ attribute: attribute("Region"), op: "eq", value: "East" }] })).not.toBe(original);
    expect(key({ viewConfig: { ...view(), values: [model.measures.find((measure) => measure.name === "Profit")!.id] } })).not.toBe(original);
  });
  it("normalizes object keys, AND filter order and IN member order without mutating inputs", () => {
    const first: QueryFilter = { attribute: attribute("Category"), op: "in", values: ["Furniture", "Technology"] };
    const second: QueryFilter = { attribute: attribute("Year"), op: "gte", value: 2022 };
    expect(key({ filters: [first, second] })).toBe(key({ filters: [second, { values: ["Technology", "Furniture"], op: "in", attribute: first.attribute }] }));
    expect(first.values).toEqual(["Furniture", "Technology"]);
    expect(key({ filters: [{ ...first, values: [1, "1", null] }] })).not.toBe(key({ filters: [{ ...first, values: [1, "1"] }] }));
  });
});
