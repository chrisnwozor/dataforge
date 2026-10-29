import { describe, expect, it } from "vitest";
import { createEmptyReport, reportColumnSchema, reportDefinitionSchema, reportDocumentSchema, reportItemSchema, type ReportDocument } from "@/lib/reports/schema";
import { createReportHistory, reportHistoryReducer } from "@/lib/reports/history";

const attribute = { table: "product", column: "category" };
const source = { kind: "fields", rows: [attribute], values: ["sales"], filters: [], sort: [] };
const table = () => reportItemSchema.parse({ id: "table", type: "table", title: "Sales", data: source, columns: [{ id: "category", label: "Category", binding: { kind: "attribute", attribute } }, { id: "sales", label: "Sales", binding: { kind: "measure", measure: "sales" }, align: "right", format: "currency" }], groups: [attribute] });

describe("versioned report definitions", () => {
  it("creates a valid printable definition and accepts supported body items with defaults", () => {
    const report = createEmptyReport("Quarterly report");
    expect(reportDocumentSchema.parse(report)).toEqual(report);
    expect(report.definition.page.margins).toEqual({ top: 36, right: 36, bottom: 36, left: 36 });
    expect(report.definition.retentionCount).toBe(20);
    const item = table();
    expect(item.type).toBe("table");
    if (item.type === "table") {
      expect(item.subtotals).toBe(true);
      expect(item.keepTogether).toBe(true);
      expect(item.columns[0].width).toBe(100);
    }
    expect(reportItemSchema.parse({ id: "matrix", type: "matrix", data: source, rows: [attribute], columns: [{ table: "calendar", column: "year" }], values: ["sales"] }).type).toBe("matrix");
    expect(reportItemSchema.parse({ id: "chart", type: "chart", data: source }).type).toBe("chart");
    expect(reportItemSchema.parse({ id: "text", type: "text", content: "<script>shown literally</script>" }).type).toBe("text");
    expect(reportItemSchema.parse({ id: "break", type: "pageBreak" }).type).toBe("pageBreak");
  });

  it("rejects unknown versions and fields instead of dropping persisted settings", () => {
    const definition = createEmptyReport().definition;
    expect(reportDefinitionSchema.safeParse({ ...definition, version: 2 }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, arbitrarySql: "SELECT secret" }).success).toBe(false);
    expect(reportDocumentSchema.safeParse({ ...createEmptyReport(), unknown: true }).success).toBe(false);
    expect(reportItemSchema.safeParse({ ...table(), data: { ...source, sql: "SELECT *" } }).success).toBe(false);
  });

  it("bounds page geometry, grouping, identifiers, text and retention", () => {
    const definition = createEmptyReport().definition;
    expect(reportDefinitionSchema.safeParse({ ...definition, page: { ...definition.page, margins: { ...definition.page.margins, left: -10 } } }).success).toBe(false);
    expect(reportItemSchema.safeParse({ ...table(), groups: Array(4).fill(attribute) }).success).toBe(false);
    expect(reportItemSchema.safeParse({ ...table(), columns: [] }).success).toBe(false);
    expect(reportColumnSchema.safeParse({ id: "column", label: "X", width: 0, binding: { kind: "measure", measure: "sales" } }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, retentionCount: 0 }).success).toBe(false);
    expect(reportItemSchema.safeParse({ id: "text", type: "text", content: "x".repeat(20_001) }).success).toBe(false);
    expect(reportItemSchema.safeParse({ id: "__proto__", type: "text", content: "Unsafe object key" }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, items: [table(), table()] }).success).toBe(false);
    const duplicateColumns = table();
    if (duplicateColumns.type === "table") duplicateColumns.columns[1].id = duplicateColumns.columns[0].id;
    expect(reportDefinitionSchema.safeParse({ ...definition, items: [duplicateColumns] }).success).toBe(false);
  });

  it("rejects nonexistent, duplicate and cyclic cascading parameter definitions", () => {
    const definition = createEmptyReport().definition;
    const parameter = { id: "category", name: "Category", type: "single", attribute, allowAll: true };
    expect(reportDefinitionSchema.safeParse({ ...definition, parameters: [parameter, parameter] }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, parameters: [{ ...parameter, dependsOn: "missing" }] }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...definition, parameters: [{ ...parameter, dependsOn: "product" }, { ...parameter, id: "product", dependsOn: "category" }] }).success).toBe(false);
  });
});

describe("report undo and redo", () => {
  it("retains fifty independent steps and clears redo after a new edit", () => {
    let history = createReportHistory(createEmptyReport("Start"));
    for (let index = 0; index < 70; index++) history = reportHistoryReducer(history, { type: "set", document: { ...history.present, name: `Report ${index}` } });
    expect(history.past).toHaveLength(50);
    history = reportHistoryReducer(history, { type: "undo" });
    expect(history.present.name).toBe("Report 68");
    expect(reportHistoryReducer(history, { type: "redo" }).present.name).toBe("Report 69");
    history = reportHistoryReducer(history, { type: "set", document: { ...history.present, name: "Different" } });
    expect(history.future).toHaveLength(0);
    expect(reportHistoryReducer(history, { type: "redo" })).toBe(history);
    expect(reportHistoryReducer(history, { type: "set", document: structuredClone(history.present) })).toBe(history);
    expect(reportHistoryReducer(history, { type: "reset", document: createEmptyReport() }).past).toHaveLength(0);
  });
  it("validates every edit without mutating existing history", () => {
    const report = createEmptyReport();
    const history = createReportHistory(report);
    report.name = "Changed outside";
    expect(history.present.name).toBe("Untitled report");
    expect(() => reportHistoryReducer(history, { type: "set", document: { ...history.present, definition: { ...history.present.definition, version: 2 } } as unknown as ReportDocument })).toThrow();
    expect(history.present.definition.version).toBe(1);
  });
});
