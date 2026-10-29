import { describe, expect, it } from "vitest";
import { attributeKey, createEmptyView, createStarterView, toSemanticQuery, viewConfigSchema, viewReducer, type ViewConfig } from "@/lib/explore/config";
import { decodeViewConfig, encodeViewConfig } from "@/lib/explore/url";
import { buildPivot } from "@/lib/explore/pivot";
import { csvCell, resultToCsv } from "@/lib/explore/csv";
import { formatAttribute, formatMeasure, formatValue } from "@/lib/explore/format";
import { calculateWindow } from "@/lib/explore/virtual";
import { drillDown, drillThrough, drillUp } from "@/lib/explore/drill";
import type { QueryResult, QueryResultColumn } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";

const year = { table: "date", column: "year" };
const quarter = { table: "date", column: "quarter" };
const month = { table: "date", column: "month" };
const category = { table: "product", column: "category" };
const model: SemanticModel = {
  projectId: "project", version: "v1", factTableId: "fact", relationships: [],
  tables: [{ id: "date", name: "dim_date", schema: "dw", sqlName: "dim_date", kind: "dimension", keyColumnId: "datekey", columns: [{ id: "datekey", tableId: "date", name: "Date Key", sqlName: "datekey", type: "number", role: "key" }, ...["year", "quarter", "month"].map((name) => ({ id: name, tableId: "date", name, sqlName: name, type: "number" as const, role: "attribute" as const }))] }],
  measures: [
    { id: "average", name: "Average", expression: "AVG(fact_sales[sales])", format: "currency", folder: "Sales", description: "", isAuto: true, createdAt: "", updatedAt: "" },
    { id: "sales", name: "Sales", expression: "SUM(fact_sales[sales])", format: "currency", folder: "Sales", description: "", isAuto: true, createdAt: "", updatedAt: "" },
  ],
  hierarchies: [{ id: "calendar", name: "Calendar", tableId: "date", levels: ["year", "quarter", "month"], isAuto: true }],
};
const base = (): ViewConfig => ({ ...createEmptyView(), values: ["sales"], rows: [year] });
const column = (key: string, role: "attribute" | "measure", name = key): QueryResultColumn => ({ key, role, name, type: role === "measure" ? "number" : "string" });
const result = (columns: QueryResultColumn[], rows: QueryResult["rows"]): QueryResult => ({ columns, rows, rowCount: rows.length, elapsedMs: 10, fromCache: false, truncated: false, sql: "generated" });

describe("Explore view config and reducer", () => {
  it("starts with the first additive measure and dimension attribute", () => {
    expect(createStarterView(model)).toMatchObject({ version: 1, values: ["sales"], rows: [year], viz: "table" });
    expect(createStarterView({ ...model, tables: [], measures: [] })).toMatchObject({ rows: [], values: [] });
  });
  it("validates a bounded versioned format and rejects future versions", () => {
    expect(viewConfigSchema.parse(base()).version).toBe(1);
    expect(viewConfigSchema.safeParse({ ...base(), version: 2 }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...base(), arbitrarySql: "SELECT 1" }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...base(), values: Array.from({ length: 65 }, (_, index) => `m${index}`) }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...base(), options: { ...base().options, seriesColors: ["url(evil)"] } }).success).toBe(false);
  });
  it("rejects duplicate grouping assignments and duplicate measures", () => {
    expect(viewConfigSchema.safeParse({ ...base(), columns: [year] }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...base(), values: ["sales", "sales"] }).success).toBe(false);
  });
  it("adds and moves fields without duplication or mutating the original", () => {
    const initial = base();
    const moved = viewReducer(initial, { type: "add", shelf: "columns", field: year });
    expect(moved.rows).toEqual([]);
    expect(moved.columns).toEqual([year]);
    expect(initial.rows).toEqual([year]);
    expect(viewReducer(initial, { type: "add", shelf: "values", field: "sales" })).toEqual(initial);
    expect(viewReducer(initial, { type: "add", shelf: "rows", field: "sales" })).toEqual(initial);
  });
  it("supports reorder and removal on shelves", () => {
    const initial = { ...base(), rows: [year, quarter, month] };
    const reordered = viewReducer(initial, { type: "move", from: "rows", to: "rows", index: 2, targetIndex: 0 });
    expect(reordered.rows).toEqual([month, year, quarter]);
    expect(viewReducer(reordered, { type: "remove", shelf: "rows", index: 1 }).rows).toEqual([month, quarter]);
    expect(viewReducer(initial, { type: "move", from: "values", to: "rows", index: 0 })).toEqual(initial);
  });
  it("prunes sorts and Top N referring to removed fields", () => {
    const initial = { ...base(), sort: [{ ref: year, dir: "asc" as const }, { ref: "sales", dir: "desc" as const }], topN: { measure: "sales", n: 10 } };
    const removedAttribute = viewReducer(initial, { type: "remove", shelf: "rows", index: 0 });
    expect(removedAttribute.sort).toEqual([{ ref: "sales", dir: "desc" }]);
    const removedMeasure = viewReducer(removedAttribute, { type: "remove", shelf: "values", index: 0 });
    expect(removedMeasure.sort).toEqual([]);
    expect(removedMeasure.topN).toBeUndefined();
  });
  it("enforces max column and total grouping sizes on UI gestures", () => {
    const initial = { ...base(), columns: Array.from({ length: 4 }, (_, index) => ({ table: "t", column: String(index) })) };
    expect(viewReducer(initial, { type: "add", shelf: "columns", field: category })).toEqual(initial);
  });
  it("changes visualization, formatting, sort, Top N and filters", () => {
    const initial = base();
    const viz = viewReducer(initial, { type: "viz", viz: "line" });
    const formatted = viewReducer(viz, { type: "options", options: { title: "Trend", showTotals: false } });
    expect(formatted).toMatchObject({ viz: "line", options: { title: "Trend", showTotals: false, barOrientation: "vertical" } });
    expect(viewReducer(formatted, { type: "sort", sort: [{ ref: "sales", dir: "desc" }] }).sort).toEqual([{ ref: "sales", dir: "desc" }]);
    expect(viewReducer(formatted, { type: "topN", topN: { measure: "sales", n: 10 } }).topN).toEqual({ measure: "sales", n: 10 });
    const filters = [{ attribute: year, op: "gte" as const, value: 2020 }];
    expect(viewReducer(formatted, { type: "filters", filters }).filters).toEqual(filters);
  });
  it("emits only the existing semantic query contract with the 50,000 cap", () => {
    expect(toSemanticQuery(base())).toEqual({ measures: ["sales"], rows: [year], columns: [], filters: [], orderBy: [], topN: undefined, limit: 50_000, hideUnknown: true });
  });
  it("uses collision-safe compound attribute keys", () => {
    expect(attributeKey({ table: "a:b", column: "c" })).not.toBe(attributeKey({ table: "a", column: "b:c" }));
  });
});

describe("Explore URL state", () => {
  it("round-trips unicode, quote characters, all options and range filters", () => {
    const config = { ...base(), filters: [{ attribute: year, op: "gte" as const, value: 2020 }], options: { ...base().options, title: 'Résumé 東京 📈 "sales"' } };
    const encoded = encodeViewConfig(config);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeViewConfig(encoded)).toEqual(config);
  });
  it("rejects malformed, oversized and unsupported states without throwing", () => {
    for (const encoded of ["", "%%%", "a".repeat(64_001), btoa('{"version":99}'), btoa("invalid json")]) expect(decodeViewConfig(encoded)).toBeNull();
  });
});

describe("Explore pivot builder", () => {
  const columns = [column("a0", "attribute", "Region"), column("a1", "attribute", "Category"), column("m0", "measure", "Sales"), column("m1", "measure", "Margin")];
  const config = { rows: [year], columns: [category] };
  const long = result(columns, [{ a0: "East", a1: "Furniture", m0: 100, m1: 0.1 }, { a0: "East", a1: "Office", m0: 900, m1: 0.3 }, { a0: "West", a1: "Furniture", m0: 200, m1: 0.5 }]);
  it("reshapes long rows without summing measure cells", () => {
    const pivot = buildPivot(long, config);
    expect(pivot.columns.map((item) => item.members)).toEqual([["Furniture"], ["Office"]]);
    expect(pivot.rows[0].members).toEqual(["East"]);
    expect(pivot.rows[0].values['["Furniture"]']).toEqual([100, 0.1]);
    expect(pivot.rows[0].total).toEqual([null, null]);
    expect(pivot.grandTotal).toEqual([null, null]);
  });
  it("uses separately queried totals so ratios and averages stay correct", () => {
    const rows = result([column("a0", "attribute", "Region"), column("m0", "measure", "Sales"), column("m1", "measure", "Margin")], [{ a0: "East", m0: 1000, m1: 0.28 }, { a0: "West", m0: 200, m1: 0.5 }]);
    const columnTotals = result([column("a0", "attribute", "Category"), column("m0", "measure", "Sales"), column("m1", "measure", "Margin")], [{ a0: "Furniture", m0: 300, m1: 0.3666667 }, { a0: "Office", m0: 900, m1: 0.3 }]);
    const grand = result([column("m0", "measure", "Sales"), column("m1", "measure", "Margin")], [{ m0: 1200, m1: 0.3166667 }]);
    const pivot = buildPivot(long, config, { rows, columns: columnTotals, grand });
    expect(pivot.rows[0].total).toEqual([1000, 0.28]);
    expect(pivot.columnTotals['["Furniture"]']).toEqual([300, 0.3666667]);
    expect(pivot.grandTotal).toEqual([1200, 0.3166667]);
  });
  it("aligns server totals by measure name when aliases change", () => {
    const grand = result([column("m7", "measure", "Margin"), column("m6", "measure", "Sales")], [{ m7: 0.25, m6: 1200 }]);
    expect(buildPivot(long, config, { grand }).grandTotal).toEqual([1200, 0.25]);
  });
  it("limits distinct column members to 50 while preserving all row members", () => {
    const many = result(columns, Array.from({ length: 51 }, (_, index) => ({ a0: `row${index}`, a1: `column${index}`, m0: index, m1: 0.1 })));
    const pivot = buildPivot(many, config);
    expect(pivot.columns).toHaveLength(50);
    expect(pivot.rows).toHaveLength(51);
    expect(pivot.totalColumnMembers).toBe(51);
    expect(pivot.truncatedColumns).toBe(true);
    expect(pivot.rows[50].values).toEqual({});
  });
  it("preserves the server-side 50-column truncation warning", () => {
    const capped = { ...result(columns, Array.from({ length: 50 }, (_, index) => ({ a0: "East", a1: `column${index}`, m0: index, m1: 0.1 }))), truncated: true, pivot: { rowKeys: ["a0"], columnKeys: ["a1"], measureKeys: ["m0", "m1"], columnValues: [] } };
    expect(buildPivot(capped, config)).toMatchObject({ truncatedColumns: true, totalColumnMembers: 50 });
  });
  it("keeps null members distinct from literal strings and absent cells", () => {
    const nullable = result(columns, [{ a0: null, a1: null, m0: 0, m1: null }, { a0: "null", a1: "null", m0: 2, m1: 0 }]);
    const pivot = buildPivot(nullable, config);
    expect(pivot.rows.map((item) => item.key)).toEqual(["[null]", '["null"]']);
    expect(pivot.rows[0].values["[null]"]).toEqual([0, null]);
    expect(pivot.rows[0].values['["null"]']).toBeUndefined();
  });
  it("does not report truncated server totals as complete", () => {
    const rows = { ...long, truncated: true };
    expect(buildPivot(long, config, { rows }).rows[0].total).toEqual([null, null]);
  });
  it("supports an ungrouped KPI result and empty results", () => {
    const scalar = result([column("m0", "measure", "Sales")], [{ m0: 20 }]);
    expect(buildPivot(scalar, { rows: [], columns: [] }).rows[0].values["[]"]).toEqual([20]);
    expect(buildPivot(result(columns, []), config).rows).toEqual([]);
  });
});

describe("Explore number formatting", () => {
  it("renders integer years without grouping separators", () => {
    expect(formatAttribute(2022, { name: "Year", type: "number" })).toBe("2022");
    expect(formatAttribute(2022, { name: "Period", type: "number" })).toBe("2022");
    expect(formatAttribute(2201, { name: "Year", type: "number" })).toBe("2201");
    expect(formatAttribute(2201, { name: "Count", type: "number" })).toBe("2,201");
  });
  it("uses measure metadata formats without treating sales as a year", () => {
    expect(formatMeasure(2022, "currency")).toBe("$2,022.00");
    expect(formatMeasure(2022, "number")).toBe("2,022");
    expect(formatMeasure(0.125, "percent")).toBe("12.5%");
    expect(formatMeasure(1.2, "decimals")).toBe("1.20");
  });
  it("formats driver numeric measure strings while preserving integer precision and dimension text", () => {
    expect(formatMeasure("2000", "number")).toBe("2,000");
    expect(formatMeasure("9007199254740993", "number")).toBe("9,007,199,254,740,993");
    expect(formatMeasure("-2000", "number")).toBe("-2,000");
    expect(formatMeasure("1200.50", "currency")).toBe("$1,200.50");
    expect(formatMeasure("0.1253", "percent")).toBe("12.53%");
    expect(formatMeasure("1e3", "decimals")).toBe("1,000.00");
    expect(formatAttribute("2022", { name: "Year", type: "number" })).toBe("2022");
    expect(formatAttribute("002000", { name: "Code", type: "string" })).toBe("002000");
  });
  it("uses an em dash for null, empty and invalid numeric values", () => {
    for (const value of [null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY]) expect(formatValue(value)).toBe("—");
    expect(formatValue(false)).toBe("False");
    expect(formatValue(0)).toBe("0");
  });
});

describe("Explore virtualization", () => {
  it("windows a 50,000 row result with constant-size overscan", () => {
    const window = calculateWindow({ count: 50_000, scrollTop: 900_000, viewportHeight: 360, rowHeight: 36, overscan: 6 });
    expect(window).toEqual({ start: 24_994, end: 25_016, offsetTop: 899_784, totalHeight: 1_800_000, paddingBottom: 899_424 });
    expect(window.end - window.start).toBe(22);
  });
  it("clamps the beginning, end, empty lists and shrinking result sets", () => {
    expect(calculateWindow({ count: 100, scrollTop: -50, viewportHeight: 360, rowHeight: 36 }).start).toBe(0);
    expect(calculateWindow({ count: 100, scrollTop: 99_000, viewportHeight: 360, rowHeight: 36 }).end).toBe(100);
    expect(calculateWindow({ count: 0, scrollTop: 99_000, viewportHeight: 360, rowHeight: 36 })).toMatchObject({ start: 0, end: 0, totalHeight: 0, paddingBottom: 0 });
    expect(calculateWindow({ count: 2, scrollTop: 99_000, viewportHeight: 360, rowHeight: 36 })).toMatchObject({ start: 0, end: 2 });
  });
  it("handles a partially visible row and invalid row sizes", () => {
    expect(calculateWindow({ count: 100, scrollTop: 37, viewportHeight: 36, rowHeight: 36, overscan: 0 })).toMatchObject({ start: 1, end: 3 });
    expect(calculateWindow({ count: 10, scrollTop: Number.NaN, viewportHeight: 0, rowHeight: 0 })).toMatchObject({ start: 0, totalHeight: 360 });
  });
});

describe("Explore CSV formatting", () => {
  it("uses RFC4180 escaping, CRLF, a UTF-8 BOM and empty null cells", () => {
    const csv = resultToCsv(result([column("a", "attribute", 'Category "name"'), column("m", "measure", "Sales")], [{ a: 'Desk, "wide"\nnew', m: 12.5 }, { a: null, m: null }]));
    expect(csv).toBe('\uFEFF"Category ""name""",Sales\r\n"Desk, ""wide""\nnew",12.5\r\n,\r\n');
  });
  it("protects spreadsheet formula strings while preserving negative numbers", () => {
    for (const text of ["=SUM(A1)", "+cmd", "-cmd", "@cmd", "  =1", "\tformula"]) expect(csvCell(text)).toBe(`'${text}`);
    expect(csvCell(-42)).toBe("-42");
    expect(csvCell(true)).toBe("true");
  });
  it("never exports more than the supported 50,000 rows", () => {
    const csv = resultToCsv(result([column("m", "measure")], Array.from({ length: 50_001 }, (_, index) => ({ m: index }))));
    expect(csv.split("\r\n")).toHaveLength(50_002);
    expect(csv).not.toContain("\r\n50000\r\n");
  });
});

describe("Explore drill transitions", () => {
  it("drills one hierarchy level and preserves the clicked context", () => {
    const original = base();
    const down = drillDown(original, model, year, 2022);
    expect(down?.config.rows).toEqual([quarter]);
    expect(down?.config.filters).toEqual([{ attribute: year, op: "eq", value: 2022 }]);
    const next = drillDown(down!.config, model, quarter, 2);
    expect(next?.config.rows).toEqual([month]);
    expect(next?.config.filters).toHaveLength(2);
    expect(drillDown(next!.config, model, month, 4)).toBeNull();
    expect(drillUp(next!.config, next!.step)).toEqual(down!.config);
    expect(drillUp(down!.config, down!.step)).toEqual(original);
  });
  it("drills column members too, and ignores attributes not on a shelf", () => {
    const config = { ...base(), rows: [], columns: [year] };
    expect(drillDown(config, model, year, 2022)?.config.columns).toEqual([quarter]);
    expect(drillDown(base(), model, category, "Furniture")).toBeNull();
  });
  it("supports null drill-through and avoids repeated identical filters", () => {
    const filtered = drillThrough(base(), category, null);
    expect(filtered.filters).toEqual([{ attribute: category, op: "isNull" }]);
    expect(drillThrough(filtered, category, null)).toBe(filtered);
  });
  it("restores prior filters on drill-up while preserving formatting changes", () => {
    const config = { ...base(), filters: [{ attribute: category, op: "eq" as const, value: "Furniture" }] };
    const down = drillDown(config, model, year, 2022)!;
    const edited = { ...down.config, options: { ...down.config.options, title: "Focused" } };
    expect(drillUp(edited, down.step)).toMatchObject({ filters: config.filters, rows: [year], options: { title: "Focused" } });
  });
});
