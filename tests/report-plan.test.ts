import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyView } from "@/lib/explore/config";
import { planReportQueries } from "@/lib/reports/plan";
import { generateStarterReport } from "@/lib/reports/starter";
import { createEmptyReport, reportDocumentSchema, reportItemSchema, type ReportDefinition, type ReportTable } from "@/lib/reports/schema";
import { compileQuery } from "@/lib/semantic/query/compile";
import type { SemanticModel } from "@/lib/semantic/types";
import { createSuperstoreSemanticFixture } from "./fixtures/superstore-semantic";

let model: SemanticModel;
beforeAll(async () => { model = await createSuperstoreSemanticFixture(); });
const category = { table: "product", column: "category" };
const product = { table: "product", column: "name" };
const fields = { kind: "fields" as const, rows: [category, product], values: ["sales"], filters: [], sort: [] };
function table(id = "table", measure = "sales"): ReportTable {
  return reportItemSchema.parse({ id, type: "table", title: "Sales by Category", data: { ...fields, values: [measure] }, columns: [{ id: "category", label: "Category", binding: { kind: "attribute", attribute: category } }, { id: "product", label: "Product", binding: { kind: "attribute", attribute: product } }, { id: "value", label: measure, binding: { kind: "measure", measure } }], groups: [category], subtotals: true, grandTotal: true }) as ReportTable;
}
const definition = (...items: ReportDefinition["items"]): ReportDefinition => ({ ...createEmptyReport().definition, items });

describe("semantic report query planning", () => {
  it("plans server subtotal and grand-total contexts without summing detail ratios", () => {
    const [plan] = planReportQueries(definition(table("margin", "margin")));
    expect(plan.main.measures).toEqual(["margin"]);
    expect(plan.main.rows).toEqual([category, product]);
    expect(plan.totals).toHaveLength(2);
    expect(plan.totals[0]).toMatchObject({ groupBy: [category], query: { measures: ["margin"], rows: [category], filters: [] } });
    expect(plan.totals[1]).toMatchObject({ key: "grand", groupBy: [], query: { measures: ["margin"], rows: [] } });
    expect(plan.totals.every((total) => total.query.topN === undefined)).toBe(true);
  });
  it("batches all requested measures sharing a query context across report items", () => {
    const plans = planReportQueries(definition(table("sales", "sales"), table("profit", "profit")));
    expect(plans[0].main.measures).toEqual(["sales", "profit"]);
    expect(plans[1].main).toEqual(plans[0].main);
    expect(plans[0].totals[0].query.measures).toEqual(["sales", "profit"]);
    expect(plans[1].totals[1].query).toEqual(plans[0].totals[1].query);
  });
  it("intersects fixed filters with parameters and never embeds parameter text as SQL", () => {
    const item = table();
    if (item.data.kind !== "fields") throw new Error("Expected fields");
    item.data.filters.push({ attribute: category, op: "ne", value: "Excluded" });
    const input = definition(item);
    input.parameters.push({ id: "category", name: "Category", type: "single", attribute: category, allowAll: true });
    const [plan] = planReportQueries(input, { category: "x'; DROP TABLE data;--" });
    expect(plan.main.filters).toEqual([{ attribute: category, op: "ne", value: "Excluded" }, { attribute: category, op: "eq", value: "x'; DROP TABLE data;--" }]);
    expect(plan.totals.every((total) => total.query.filters === plan.main.filters)).toBe(true);
  });
  it("resolves saved views and rejects a missing view instead of silently inventing data", () => {
    const viewId = "11111111-1111-4111-8111-111111111111";
    const item = { ...table(), data: { kind: "view" as const, viewId } };
    const saved = { id: viewId, config: { ...createEmptyView(), rows: [category, product], values: ["sales"] } };
    expect(planReportQueries(definition(item), {}, [saved])[0].main.rows).toEqual([category, product]);
    expect(() => planReportQueries(definition(item))).toThrow(/unavailable/);
  });
  it("orders parent groups first and keeps per-group Top N distinct from global Top N", () => {
    const item = table();
    item.topNPerGroup = { measure: "sales", n: 3 };
    if (item.data.kind !== "fields") throw new Error("Expected fields");
    item.data.topN = { measure: "sales", n: 1 };
    item.data.sort = [{ ref: "sales", dir: "desc" }];
    const [plan] = planReportQueries(definition(item));
    expect(plan.main.orderBy).toEqual([{ ref: category, dir: "asc" }, { ref: "sales", dir: "desc" }]);
    expect(plan.main.topN).toBeUndefined();
    expect(plan.main.limit).toBe(100_000);
    expect(plan.main.report).toBe(true);
  });
  it("flattens a saved pivot's column attributes into long report-table rows without assigning them twice", () => {
    const viewId = "11111111-1111-4111-8111-111111111111";
    const item = { ...table(), data: { kind: "view" as const, viewId } };
    const saved = { id: viewId, config: { ...createEmptyView(), viz: "pivot" as const, rows: [category], columns: [product], values: ["sales"] } };
    const [plan] = planReportQueries(definition(item), {}, [saved]);
    expect(plan.main.rows).toEqual([category, product]);
    expect(plan.main.columns).toEqual([]);
  });
  it("plans matrix row, column and grand totals at independent server grouping grains", () => {
    const year = { table: "calendar", column: "year" };
    const item = reportItemSchema.parse({ id: "matrix", type: "matrix", data: fields, rows: [category], columns: [year], values: ["margin"] });
    const [plan] = planReportQueries(definition(item));
    expect(plan.main.rows).toEqual([category]);
    expect(plan.main.columns).toEqual([year]);
    expect(plan.totals.map((total) => total.groupBy)).toEqual([[category], [category, year], [year], []]);
  });
});

describe("metadata-only starter reports", () => {
  it("generates a deterministic Superstore Category/Product report and monthly summary", () => {
    const report = generateStarterReport(model);
    expect(reportDocumentSchema.parse(report)).toEqual(report);
    expect(generateStarterReport(structuredClone(model))).toEqual(report);
    expect(report.name).toBe("Sales by Category");
    expect(report.definition.items.map((item) => item.type)).toEqual(["table", "pageBreak", "table"]);
    expect(report.definition.parameters[0]).toMatchObject({ name: "Category", type: "multi", default: null });
    const plans = planReportQueries(report.definition, {}, [], model);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(() => compileQuery(model, plan.main)).not.toThrow();
      plan.totals.forEach((total) => expect(() => compileQuery(model, total.query)).not.toThrow());
    }
  });
  it("keeps a hostile parameter in a typed SQL parameter when compiling the real Superstore report", () => {
    const report = generateStarterReport(model);
    const hostile = "Furniture'; DROP TABLE dw.fact_sales;--";
    const [plan] = planReportQueries(report.definition, { category: [hostile] }, [], model);
    const compiled = compileQuery(model, plan.main);
    expect(compiled.sql).not.toContain(hostile);
    expect(compiled.params.some((parameter) => parameter.value === hostile)).toBe(true);
  });
  it("does not invent monthly summaries when a model has no date dimension", () => {
    const without = structuredClone(model);
    without.tables = without.tables.filter((table) => table.id !== without.date?.tableId);
    without.relationships = without.relationships.filter((link) => link.toTableId !== without.date?.tableId);
    delete without.date;
    const report = generateStarterReport(without);
    expect(report.definition.items.map((item) => item.type)).toEqual(["table"]);
  });
  it("explains an empty semantic model and handles a model without categories", () => {
    const noMeasures = { ...model, measures: [] };
    expect(generateStarterReport(noMeasures).definition.items[0]).toMatchObject({ type: "text", title: "Start with a measure" });
    const noDimensions = { ...model, date: undefined, tables: model.tables.filter((table) => table.kind === "fact"), relationships: [] };
    const report = generateStarterReport(noDimensions);
    expect(report.definition.items[0]).toMatchObject({ type: "table", groups: [] });
    expect(report.definition.parameters).toEqual([]);
  });
});
