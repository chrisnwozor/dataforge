import type { AttributeRef } from "@/lib/semantic/query/types";
import type { SemanticColumn, SemanticModel, SemanticTable } from "@/lib/semantic/types";
import { createEmptyReport, reportDocumentSchema, type ReportColumn, type ReportDataSource, type ReportDocument, type ReportTable } from "./schema";

interface Attribute { table: SemanticTable; column: SemanticColumn }
const fold = (value: string) => value.toLocaleLowerCase("en-US");
const reference = ({ table, column }: Attribute): AttributeRef => ({ table: table.id, column: column.id });
export function generateStarterReport(model: SemanticModel): ReportDocument {
  const report = createEmptyReport("Sales by Category");
  report.description = "A paginated report generated from the semantic model. Customize its fields, groups and parameters.";
  const measure = model.measures.find((entry) => fold(entry.name) === "sales") ?? model.measures.find((entry) => /^\s*SUM\s*\(/i.test(entry.expression)) ?? model.measures[0];
  const attributes = model.tables.filter((table) => table.kind === "dimension").flatMap((table) => table.columns.filter((column) => column.role === "attribute").map((column) => ({ table, column })));
  const category = attributes.find((entry) => fold(entry.column.name) === "category") ?? attributes.filter((entry) => entry.table.id !== model.date?.tableId && typeof entry.column.distinctCount === "number" && entry.column.distinctCount <= 50).sort((a, b) => a.column.distinctCount! - b.column.distinctCount! || a.column.name.localeCompare(b.column.name, "en-US"))[0] ?? attributes.find((entry) => entry.table.id !== model.date?.tableId);
  if (!measure) {
    report.definition.items = [{ id: "starter-text", type: "text", title: "Start with a measure", content: "Add a measure in Measures, then choose fields or a saved Explore view for this report." }];
    return report;
  }
  const table = (id: string, title: string, rows: Attribute[], groups: AttributeRef[]): ReportTable => {
    const columns: ReportColumn[] = [...rows.map((entry, index): ReportColumn => ({ id: `${id}-attribute-${index}`, label: entry.column.name.slice(0, 200), width: rows.length > 1 ? 150 : 220, align: "left", format: "auto", binding: { kind: "attribute", attribute: reference(entry) } })), { id: `${id}-measure`, label: measure.name.slice(0, 200), width: 140, align: "right", format: "auto", binding: { kind: "measure", measure: measure.id } }];
    const data: ReportDataSource = { kind: "fields", rows: rows.map(reference), values: [measure.id], filters: [], sort: rows.map((entry) => ({ ref: reference(entry), dir: "asc" })) };
    return { id, type: "table", title, data, columns, groups, subtotals: true, grandTotal: true, keepTogether: true, hideOnEmpty: false, conditionalFormats: [] };
  };
  const mainTitle = `${measure.name}${category ? ` by ${category.column.name}` : " summary"}`.slice(0, 200);
  report.name = mainTitle.slice(0, 120);
  report.definition.header.title = mainTitle;
  const detail = category ? attributes.find((entry) => entry.table.id === category.table.id && fold(entry.column.name) === "product") : undefined;
  report.definition.items = [table("starter-category", mainTitle, category ? [category, ...(detail ? [detail] : [])] : [], category ? [reference(category)] : [])];
  if (category) report.definition.parameters.push({ id: "category", name: category.column.name.slice(0, 120), type: "multi", attribute: reference(category), allowAll: true, default: null });
  if (model.date) {
    const year = attributes.find((entry) => entry.table.id === model.date?.tableId && fold(entry.column.name) === "year");
    const month = attributes.find((entry) => entry.table.id === model.date?.tableId && fold(entry.column.name) === "month");
    if (year && month) {
      report.definition.items.push({ id: "starter-month-break", type: "pageBreak", title: "" }, table("starter-monthly", `${measure.name} monthly summary`.slice(0, 200), [year, month], [reference(year)]));
    }
  }
  return reportDocumentSchema.parse(report);
}
