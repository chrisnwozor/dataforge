import { describe, expect, it } from "vitest";
import { cascadeReportParameters, reportParameterFilters, reportParameterSummary, validateReportParameters } from "@/lib/reports/parameters";
import { reportParameterSchema, type ReportParameter } from "@/lib/reports/schema";
import type { SemanticModel } from "@/lib/semantic/types";

const attribute = { table: "dimension", column: "category" };
const parameter = (patch: Partial<ReportParameter> = {}): ReportParameter => reportParameterSchema.parse({ id: "category", name: "Category", type: "single", attribute, allowAll: true, ...patch });
const model: SemanticModel = { projectId: "project", version: "1", factTableId: "fact", relationships: [], measures: [], hierarchies: [], tables: [{ id: "dimension", name: "dim_product", schema: "dw", sqlName: "dim_product", kind: "dimension", keyColumnId: "key", columns: [{ id: "category", tableId: "dimension", name: "Category", sqlName: "category", type: "string", role: "attribute" }] }] };

describe("typed report parameters", () => {
  it("uses defaults and optional All values, while rejecting missing required or extra parameters", () => {
    expect(validateReportParameters([parameter({ default: "Furniture" })], {})).toEqual({ category: "Furniture" });
    expect(validateReportParameters([parameter()], {})).toEqual({ category: null });
    expect(reportParameterFilters([parameter()], { category: null })).toEqual([]);
    expect(() => validateReportParameters([parameter({ allowAll: false })], {})).toThrow(/requires a value/);
    expect(() => validateReportParameters([parameter()], { arbitrary: "x" })).toThrow(/no parameter/);
    expect(() => validateReportParameters([parameter()], { category: { sql: "SELECT secret" } })).toThrow();
  });
  it("translates selections and potentially hostile text into values only", () => {
    const injection = "x'; DROP TABLE users;--";
    expect(reportParameterFilters([parameter()], { category: injection })).toEqual([{ attribute, op: "eq", value: injection }]);
    expect(reportParameterFilters([parameter({ type: "multi" })], { category: ["Furniture", "Technology"] })).toEqual([{ attribute, op: "in", values: ["Furniture", "Technology"] }]);
    expect(reportParameterFilters([parameter({ type: "multi" })], { category: [] })).toEqual([{ attribute, op: "in", values: [] }]);
    expect(reportParameterFilters([parameter({ type: "number" })], { category: 12 })).toEqual([{ attribute, op: "eq", value: 12 }]);
    expect(reportParameterFilters([parameter({ type: "text" })], { category: "A,B" })).toEqual([{ attribute, op: "eq", value: "A,B" }]);
    expect(() => validateReportParameters([parameter({ type: "single" })], { category: ["Furniture"] })).toThrow();
    expect(() => validateReportParameters([parameter({ type: "multi" })], { category: "Furniture" })).toThrow();
    expect(() => validateReportParameters([parameter({ type: "number" })], { category: "12" })).toThrow();
    expect(() => validateReportParameters([parameter({ type: "number" })], { category: Infinity })).toThrow();
  });
  it("validates real ISO dates, inclusive open boundaries and ordering", () => {
    const date = parameter({ type: "dateRange" });
    expect(reportParameterFilters([date], { category: { from: "2024-02-29", to: "2024-12-31" } })).toEqual([{ attribute, op: "gte", value: "2024-02-29" }, { attribute, op: "lte", value: "2024-12-31" }]);
    expect(reportParameterFilters([date], { category: { to: "2024-12-31" } })).toEqual([{ attribute, op: "lte", value: "2024-12-31" }]);
    expect(() => validateReportParameters([date], { category: { from: "2024-02-30" } })).toThrow(/valid ISO dates/);
    expect(() => validateReportParameters([date], { category: { from: "2025-01-01", to: "2024-12-31" } })).toThrow(/before/);
    expect(() => validateReportParameters([parameter({ type: "dateRange", allowAll: false })], { category: {} })).toThrow(/boundary/);
  });
  it("checks semantic attribute types and never accepts measure-source columns as parameters", () => {
    expect(validateReportParameters([parameter()], { category: "Furniture" }, model)).toEqual({ category: "Furniture" });
    expect(() => validateReportParameters([parameter({ type: "number" })], { category: 12 }, model)).toThrow(/type string/);
    expect(() => validateReportParameters([parameter({ attribute: { table: "dimension", column: "missing" } })], { category: "Furniture" }, model)).toThrow(/dimension attribute/);
    expect(() => validateReportParameters([parameter({ attribute: { table: "dimension", column: "missing" } })], { category: null }, model)).toThrow(/dimension attribute/);
    expect(() => validateReportParameters([parameter()], { category: null }, { ...model, tables: model.tables.map((table) => ({ ...table, kind: "fact" as const })) })).toThrow(/dimension attribute/);
  });
  it("clears transitive descendants after a cascading change and leaves unrelated defaults intact", () => {
    const parameters = [parameter(), parameter({ id: "product", name: "Product", dependsOn: "category" }), parameter({ id: "sku", name: "SKU", dependsOn: "product" }), parameter({ id: "region", default: "East" })];
    expect(cascadeReportParameters(parameters, { category: "A", product: "B", sku: "C", region: "West" }, "category", "New")).toEqual({ category: "New", product: null, sku: null, region: "West" });
    expect(cascadeReportParameters(parameters, {}, "category", null).region).toBe("East");
  });
  it("summarizes applied values without interpreting HTML or SQL", () => {
    const parameters = [parameter(), parameter({ id: "date", name: "Date", type: "dateRange" }), parameter({ id: "segments", name: "Segments", type: "multi" })];
    expect(reportParameterSummary(parameters, { category: null, date: { from: "2024-01-01" }, segments: ["A", "B"] })).toBe("Category: All · Date: 2024-01-01 – Any · Segments: A, B");
  });
});
