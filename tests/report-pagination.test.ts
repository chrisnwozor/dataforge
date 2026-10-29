import { describe, expect, it } from "vitest";
import { capReportData, paginateReport, reportTabularRows, wrapReportText, REPORT_ROW_HEIGHT, type ReportExecutionData, type ReportTableRowElement } from "@/lib/reports/pagination";
import { createEmptyReport, reportDefinitionSchema, type ReportDefinition, type ReportTable } from "@/lib/reports/schema";
import type { QueryResult } from "@/lib/semantic/query/types";

const category = { table: "product", column: "Category" }, product = { table: "product", column: "Product" }, year = { table: "date", column: "Year" };
const metric = { id: "sales", label: "Sales", width: 100, align: "right", format: "currency", binding: { kind: "measure", measure: "Sales" } };
function definition(count = 0): ReportDefinition {
  const base = createEmptyReport("Sales report").definition;
  return reportDefinitionSchema.parse({ ...base, header: { ...base.header, showRunDate: false, showParameters: false }, items: [{ id: "table", type: "table", title: "", data: { kind: "fields", rows: [category, product], values: ["Sales"] }, columns: [{ id: "category", label: "Category", width: 150, binding: { kind: "attribute", attribute: category } }, metric], groups: [], subtotals: false, grandTotal: false, keepTogether: true }], ...(count ? { retentionCount: count } : {}) });
}
function result(rows: Record<string, string | number | null>[]): QueryResult {
  return { columns: [{ key: "c", name: "Category", role: "attribute", type: "string" }, { key: "p", name: "Product", role: "attribute", type: "string" }, { key: "s", name: "Sales", role: "measure", type: "number" }], rows, rowCount: rows.length, truncated: false, elapsedMs: 5, fromCache: false, sql: "" };
}
const data = (rows: Record<string, string | number | null>[]): ReportExecutionData => ({ items: { table: { result: result(rows), rows: [category, product], measures: ["Sales"] } }, parameters: {}, runAt: "2026-10-28T13:00:00.000Z" });
const observations = (n: number) => Array.from({ length: n }, (_, index) => ({ c: `Category ${index}`, p: `Product ${index}`, s: index * 5 }));
const tableRows = (layout: ReturnType<typeof paginateReport>) => layout.pages.flatMap((page) => page.elements.filter((element): element is ReportTableRowElement => element.kind === "tableRow"));

describe("fixed report pagination", () => {
  it("is deterministic and repeats the report/table headers and correct page counters", () => {
    const source = data(observations(100)), def = definition();
    const output = paginateReport(def, source);
    expect(paginateReport(structuredClone(def), structuredClone(source))).toEqual(output);
    expect(output.pages.length).toBeGreaterThan(2);
    expect(output.rowCount).toBe(100);
    expect(tableRows(output)).toHaveLength(100);
    for (const page of output.pages) {
      expect(page.elements.some((element) => element.kind === "tableHeader")).toBe(true);
      expect(page.elements.some((element) => element.kind === "text" && element.role === "header" && element.text === "Sales report")).toBe(true);
      expect(page.elements.some((element) => element.kind === "text" && element.text === `Page ${page.number} of ${output.pages.length}`)).toBe(true);
      for (const element of page.elements) expect(element.y + element.height).toBeLessThanOrEqual(output.height - def.page.margins.bottom + 0.001);
    }
  });
  it("applies Letter/Legal/A4 orientation and margins in points", () => {
    const def = definition();
    def.page.size = "Legal"; def.page.orientation = "landscape"; def.page.margins.left = 50;
    const output = paginateReport(def, data(observations(1)));
    expect([output.width, output.height]).toEqual([1008, 612]);
    expect(output.pages[0].elements.every((element) => element.x >= 50)).toBe(true);
    const header = output.pages[0].elements.find((element) => element.kind === "tableHeader")!;
    if (header.kind === "tableHeader") expect(header.cells.reduce((sum, cell) => sum + cell.width, 0)).toBeCloseTo(922, 5);
  });
  it("does not leave one detail row alone on a new page", () => {
    const def = definition(), full = paginateReport(def, data(observations(100)));
    const capacity = full.pages[0].elements.filter((element) => element.kind === "tableRow").length;
    const output = paginateReport(def, data(observations(capacity + 1)));
    expect(output.pages).toHaveLength(2);
    expect(output.pages[1].elements.filter((element) => element.kind === "tableRow")).toHaveLength(2);
    expect(output.pages[0].elements.filter((element) => element.kind === "tableRow")).toHaveLength(capacity - 1);
  });
  it("keeps closing subtotals and grand totals with their last detail rows at page boundaries", () => {
    const plain = definition();
    const capacity = paginateReport(plain, data(observations(100))).pages[0].elements.filter((element) => element.kind === "tableRow").length;
    for (const grouped of [false, true]) {
      const def = definition(), table = def.items[0] as ReportTable;
      table.grandTotal = true; table.subtotals = grouped;
      table.groups = grouped ? [category] : [];
      table.keepTogether = false;
      for (let delta = -1; delta <= 2; delta++) {
        const count = capacity - (grouped ? 1 : 0) + delta;
        const source = data(Array.from({ length: count }, (_, index) => ({ c: "A", p: String(index), s: index })));
        const output = paginateReport(def, source);
        for (const page of output.pages) {
          const rows = page.elements.filter((element): element is ReportTableRowElement => element.kind === "tableRow");
          if (rows.some((row) => row.rowKind !== "detail")) expect(rows.filter((row) => row.rowKind === "detail").length).toBeGreaterThanOrEqual(2);
        }
        expect(tableRows(output).filter((row) => row.rowKind === "detail")).toHaveLength(count);
      }
    }
  });
  it("keeps a group together when it fits and splits oversized groups with repeated headers", () => {
    const def = definition(), table = def.items[0] as ReportTable;
    table.groups = [category];
    const records = [...Array.from({ length: 15 }, (_, index) => ({ c: "A", p: String(index), s: index })), ...Array.from({ length: 15 }, (_, index) => ({ c: "B", p: String(index), s: index }))];
    const output = paginateReport(def, data(records));
    expect(output.pages).toHaveLength(2);
    for (const page of output.pages) expect(page.elements.filter((element) => element.kind === "text" && element.role === "group")).toHaveLength(1);
    const oversized = paginateReport(def, data(Array.from({ length: 100 }, (_, index) => ({ c: "A", p: String(index), s: index }))));
    expect(oversized.pages.length).toBeGreaterThan(2);
    expect(tableRows(oversized)).toHaveLength(100);
    expect(oversized.pages.every((page) => page.elements.some((element) => element.kind === "tableHeader"))).toBe(true);
  });
  it("keeps every detail inside a short page even when its closing totals cannot fit together", () => {
    const def = definition(), table = def.items[0] as ReportTable;
    def.page.orientation = "landscape";
    def.page.margins = { top: 144, right: 144, bottom: 144, left: 144 };
    def.header.text = Array.from({ length: 9 }, (_, index) => `Header ${index}`).join("\n");
    table.groups = [category, product, year]; table.keepTogether = false;
    table.subtotals = true; table.grandTotal = true;
    const order = { table: "fact", column: "Order ID" };
    const source = data([{ c: "A", p: "Product", y: 2024, order: "one", s: 10 }, { c: "A", p: "Product", y: 2024, order: "two", s: 20 }]);
    source.items.table.rows = [category, product, year, order];
    source.items.table.result.columns.splice(2, 0, { key: "y", name: "Year", role: "attribute", type: "number" }, { key: "order", name: "Order ID", role: "attribute", type: "string" });
    const output = paginateReport(def, source);
    const rows = tableRows(output);
    expect(rows.filter((row) => row.rowKind === "detail")).toHaveLength(2);
    for (const row of rows) expect(row.y + row.height).toBeLessThanOrEqual(output.height - def.page.margins.bottom - 26);
  });
  it("honors explicit breaks while avoiding trailing or consecutive blank pages", () => {
    const def = definition();
    def.items = [{ id: "before", type: "text", title: "", content: "Before" }, { id: "break", type: "pageBreak", title: "" }, { id: "break2", type: "pageBreak", title: "" }, { id: "after", type: "text", title: "", content: "After" }, { id: "last", type: "pageBreak", title: "" }];
    const output = paginateReport(def, { items: {}, parameters: {}, runAt: "now" });
    expect(output.pages).toHaveLength(2);
    expect(output.pages[0].elements.some((element) => element.kind === "text" && element.text === "Before")).toBe(true);
    expect(output.pages[1].elements.some((element) => element.kind === "text" && element.text === "After")).toBe(true);
  });
  it("hides empty tables only when requested, wraps text predictably, and treats HTML as text", () => {
    const def = definition(); (def.items[0] as ReportTable).hideOnEmpty = true;
    def.items.push({ id: "note", type: "text", title: "", content: "<script>alert(1)</script>" });
    const output = paginateReport(def, data([]));
    expect(output.pages[0].elements.some((element) => element.kind === "tableHeader")).toBe(false);
    expect(output.pages[0].elements.some((element) => element.kind === "text" && element.text === "<script>alert(1)</script>")).toBe(true);
    expect(wrapReportText("longwordthatmustsplit", 28, 10)).toEqual(["longw", "ordth", "atmus", "tspli", "t"]);
    expect(REPORT_ROW_HEIGHT).toBe(22);
  });
});

describe("grouped server totals and tabular export values", () => {
  it("uses supplied server subtotal/grand contexts instead of summing detail ratios", () => {
    const def = definition(), table = def.items[0] as ReportTable;
    table.groups = [category]; table.subtotals = true; table.grandTotal = true;
    table.columns[1].format = "percent";
    const source = data([{ c: "A", p: "One", s: 0.1 }, { c: "A", p: "Two", s: 0.2 }]);
    source.items.table.totals = [
      { key: JSON.stringify([category]), groupBy: [category], result: { ...result([{ c: "A", s: 0.17 }]), columns: result([]).columns.filter((column) => column.key !== "p") } },
      { key: "grand", groupBy: [], result: { ...result([{ s: 0.18 }]), columns: result([]).columns.filter((column) => column.role === "measure") } },
    ];
    const tabular = reportTabularRows(def, source)[0];
    expect(tabular.rows.find((row) => row.rowKind === "subtotal")?.cells[1]).toMatchObject({ text: "17%", raw: 0.17, format: "percent", bold: true });
    expect(tabular.rows.find((row) => row.rowKind === "grandTotal")?.cells[1]).toMatchObject({ text: "18%", raw: 0.18 });
    expect(tabular.rows.find((row) => row.rowKind === "grandTotal")?.cells[0].raw).toBe("Grand total");
    expect(tabular.rows.some((row) => row.cells.some((cell) => cell.raw === 0.3))).toBe(false);
  });
  it("renders unavailable/truncated totals as em dashes and preserves conditional styles/raw cells", () => {
    const def = definition(), table = def.items[0] as ReportTable;
    table.grandTotal = true; table.conditionalFormats = [{ measure: "Sales", op: "lt", value: 0, bold: true, color: "#ff0000" }];
    const tabular = reportTabularRows(def, data([{ c: "A", p: "One", s: -10 }]))[0];
    expect(tabular.rows[0].cells[1]).toMatchObject({ raw: -10, text: "-$10.00", bold: true, color: "#ff0000" });
    expect(tabular.rows.at(-1)?.cells[1]).toMatchObject({ raw: null, text: "—" });
  });
  it("applies Top N within each group using already aggregated values while retaining independent server totals", () => {
    const def = definition(), table = def.items[0] as ReportTable;
    table.groups = [category]; table.topNPerGroup = { measure: "Sales", n: 1 };
    const tabular = reportTabularRows(def, data([{ c: "A", p: "Low", s: 1 }, { c: "A", p: "High", s: 5 }, { c: "B", p: "B low", s: 2 }, { c: "B", p: "B high", s: 8 }]))[0];
    expect(tabular.rows.filter((row) => row.rowKind === "detail").map((row) => row.cells[1].raw)).toEqual([5, 8]);
  });
  it("pivots matrices with server row/column/grand totals without client aggregation", () => {
    const def = definition();
    def.items = [reportDefinitionSchema.parse({ ...def, items: [{ id: "matrix", type: "matrix", title: "Matrix", data: { kind: "fields", rows: [category, year], values: ["Sales"] }, rows: [category], columns: [year], values: ["Sales"] }] }).items[0]];
    const base = result([]);
    const source: ReportExecutionData = { items: { matrix: { result: { ...base, columns: [{ key: "c", name: "Category", type: "string", role: "attribute" }, { key: "y", name: "Year", type: "number", role: "attribute" }, { key: "s", name: "Sales", type: "number", role: "measure" }], rows: [{ c: "A", y: 2024, s: 0.1 }, { c: "A", y: 2025, s: 0.2 }], rowCount: 2 }, totals: [
      { key: "row", groupBy: [category], result: { ...base, columns: [{ key: "c", name: "Category", type: "string", role: "attribute" }, { key: "s", name: "Sales", type: "number", role: "measure" }], rows: [{ c: "A", s: 0.17 }] } },
      { key: "column", groupBy: [year], result: { ...base, columns: [{ key: "y", name: "Year", type: "number", role: "attribute" }, { key: "s", name: "Sales", type: "number", role: "measure" }], rows: [{ y: 2024, s: 0.11 }, { y: 2025, s: 0.21 }] } },
      { key: "grand", groupBy: [], result: { ...base, columns: [{ key: "s", name: "Sales", type: "number", role: "measure" }], rows: [{ s: 0.18 }] } },
    ] } }, parameters: {}, runAt: "now" };
    const output = reportTabularRows(def, source)[0];
    expect(output.columns.map((column) => column.text)).toEqual(["Category", "2024 · Sales", "2025 · Sales", "Total · Sales"]);
    expect(output.rows[0].cells.map((cell) => cell.raw)).toEqual(["A", 0.1, 0.2, 0.17]);
    expect(output.rows[1].cells.map((cell) => cell.raw)).toEqual(["Grand total", 0.11, 0.21, 0.18]);
  });
  it("caps the report across items at 100,000 source rows and emits a clear warning", () => {
    const def = definition(), source = data(observations(100_001));
    const output = paginateReport(def, source);
    expect(output.rowCount).toBe(100_000);
    expect(output.truncated).toBe(true);
    expect(output.warnings.join(" ")).toContain("100,000-row cap");
    expect(tableRows(output)).toHaveLength(100_000);
  });
  it("shares a non-mutating raw row budget across all items before adding subtotal/header lines", () => {
    const def = definition();
    def.items.push({ ...def.items[0], id: "second" });
    const source = data(observations(60_000));
    source.items.second = { ...source.items.table };
    const capped = capReportData(def, source);
    expect(capped.items.table.result.rows).toHaveLength(60_000);
    expect(capped.items.second.result.rows).toHaveLength(40_000);
    expect(capped.items.second.result.truncated).toBe(true);
    expect(source.items.second.result.rows).toHaveLength(60_000);
    expect(source.items.second.result.truncated).toBe(false);
  });
  it("uses matrix prefix-group queries for hierarchical subtotals", () => {
    const def = reportDefinitionSchema.parse({ ...definition(), items: [{ id: "matrix", type: "matrix", title: "Nested", data: { kind: "fields", rows: [category, product, year], values: ["Sales"] }, rows: [category, product], columns: [year], values: ["Sales"], grandTotal: true, subtotals: true }] });
    const base = result([]), y = { key: "y", name: "Year", type: "number" as const, role: "attribute" as const };
    const groupColumns = (keys: string[]) => [...base.columns.filter((column) => column.role === "attribute" && keys.includes(column.key)), ...(keys.includes("y") ? [y] : []), base.columns[2]];
    const source: ReportExecutionData = { items: { matrix: { result: { ...base, columns: groupColumns(["c", "p", "y"]), rows: [{ c: "A", p: "One", y: 2024, s: 0.1 }, { c: "A", p: "Two", y: 2025, s: 0.2 }], rowCount: 2 }, rows: [category, product, year], measures: ["Sales"], totals: [
      { key: "prefix", groupBy: [category, year], result: { ...base, columns: groupColumns(["c", "y"]), rows: [{ c: "A", y: 2024, s: 0.17 }, { c: "A", y: 2025, s: 0.27 }] } },
      { key: "prefixTotal", groupBy: [category], result: { ...base, columns: groupColumns(["c"]), rows: [{ c: "A", s: 0.25 }] } },
    ] } }, parameters: {}, runAt: "now" };
    const output = reportTabularRows(def, source)[0];
    expect(output.rows.find((row) => row.rowKind === "subtotal")?.cells.map((cell) => cell.raw)).toEqual(["Category: A subtotal", "", 0.17, 0.27, 0.25]);
    expect(output.rows.filter((row) => row.rowKind === "detail")).toHaveLength(2);
    expect(output.rows[0]).toMatchObject({ rowKind: "groupHeader", label: "Category: A" });
  });
  it("continues wide matrices in horizontal column bands with repeated row labels", () => {
    const def = reportDefinitionSchema.parse({ ...definition(), items: [{ id: "matrix", type: "matrix", title: "Wide", data: { kind: "fields", rows: [category, year], values: ["Sales"] }, rows: [category], columns: [year], values: ["Sales"], grandTotal: false }] });
    const source: ReportExecutionData = { items: { matrix: { result: { ...result([]), columns: [{ key: "c", name: "Category", role: "attribute", type: "string" }, { key: "y", name: "Year", role: "attribute", type: "number" }, { key: "s", name: "Sales", role: "measure", type: "number" }], rows: Array.from({ length: 20 }, (_, index) => ({ c: "A", y: 2000 + index, s: index + 1 })), rowCount: 20 } } }, parameters: {}, runAt: "now" };
    const output = paginateReport(def, source);
    expect(output.pages).toHaveLength(5);
    expect(output.rowCount).toBe(20);
    expect(output.warnings.join(" ")).toContain("5 horizontal column bands");
    for (const page of output.pages) {
      const header = page.elements.find((element) => element.kind === "tableHeader")!;
      expect(header.kind === "tableHeader" && header.cells[0].text).toBe("Category");
      if (header.kind === "tableHeader") expect(header.cells.length).toBeLessThanOrEqual(5);
    }
  });
});
