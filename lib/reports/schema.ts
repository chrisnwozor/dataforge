import { z } from "zod";
import { attributeRefSchema, queryFilterSchema } from "@/lib/semantic/query/schema";

const ref = z.string().min(1).max(256);
const id = z.string().min(1).max(128).refine((value) => !["__proto__", "constructor", "prototype"].includes(value), "Choose an ID that is not a reserved object key.");
export const reportFormatSchema = z.enum(["auto", "number", "currency", "percent", "decimals"]);
export const reportValueSchema = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
export const reportParameterValueSchema = z.union([
  reportValueSchema,
  z.array(reportValueSchema).max(1_000),
  z.object({ from: reportValueSchema.optional(), to: reportValueSchema.optional() }).strict(),
]);
export const reportParameterValuesSchema = z.record(z.string().min(1).max(128), reportParameterValueSchema);
export const reportParameterSchema = z.object({
  id,
  name: z.string().trim().min(1).max(120),
  type: z.enum(["single", "multi", "dateRange", "number", "text"]),
  attribute: attributeRefSchema,
  default: reportParameterValueSchema.optional(),
  allowAll: z.boolean().default(true),
  dependsOn: id.optional(),
}).strict();
const orderSchema = z.array(z.object({ ref: z.union([ref, attributeRefSchema]), dir: z.enum(["asc", "desc"]) }).strict()).max(12);
const topN = z.object({ measure: ref, n: z.number().int().min(1).max(100_000) }).strict();
export const reportDataSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), viewId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("fields"), rows: z.array(attributeRefSchema).max(12), values: z.array(ref).min(1).max(64), filters: z.array(queryFilterSchema).max(64).default([]), sort: orderSchema.default([]), topN: topN.optional() }).strict(),
]);
export const reportColumnSchema = z.object({
  id,
  label: z.string().max(200),
  width: z.number().min(24).max(1_200).default(100),
  align: z.enum(["left", "center", "right"]).default("left"),
  format: reportFormatSchema.default("auto"),
  binding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("attribute"), attribute: attributeRefSchema }).strict(),
    z.object({ kind: z.literal("measure"), measure: ref }).strict(),
  ]),
}).strict();
export const reportConditionalFormatSchema = z.object({
  measure: ref,
  op: z.enum(["gt", "lt"]),
  value: z.number().finite(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bold: z.boolean().default(false),
}).strict().refine((rule) => rule.color !== undefined || rule.bold, "Choose a color or bold style.");
const common = z.object({ id, title: z.string().max(200).default("") }).strict();
const grouped = {
  subtotals: z.boolean().default(true),
  grandTotal: z.boolean().default(true),
  keepTogether: z.boolean().default(true),
  hideOnEmpty: z.boolean().default(false),
  conditionalFormats: z.array(reportConditionalFormatSchema).max(64).default([]),
};
export const reportTableSchema = common.extend({
  type: z.literal("table"), data: reportDataSourceSchema,
  columns: z.array(reportColumnSchema).min(1).max(64),
  groups: z.array(attributeRefSchema).max(3).default([]),
  topNPerGroup: topN.optional(),
  ...grouped,
});
export const reportMatrixSchema = common.extend({
  type: z.literal("matrix"), data: reportDataSourceSchema,
  rows: z.array(attributeRefSchema).min(1).max(3),
  columns: z.array(attributeRefSchema).min(1).max(4),
  values: z.array(ref).min(1).max(64),
  ...grouped,
});
export const reportChartSchema = common.extend({ type: z.literal("chart"), data: reportDataSourceSchema, viz: z.enum(["bar", "line", "area", "donut"]).default("bar"), height: z.number().min(100).max(600).default(220) });
export const reportTextSchema = common.extend({ type: z.literal("text"), content: z.string().max(20_000) });
export const reportPageBreakSchema = common.extend({ type: z.literal("pageBreak") });
export const reportItemSchema = z.discriminatedUnion("type", [reportTableSchema, reportMatrixSchema, reportChartSchema, reportTextSchema, reportPageBreakSchema]);
export const reportPageSchema = z.object({
  size: z.enum(["Letter", "A4", "Legal"]).default("A4"),
  orientation: z.enum(["portrait", "landscape"]).default("portrait"),
  margins: z.object({ top: z.number().min(12).max(144).default(36), right: z.number().min(12).max(144).default(36), bottom: z.number().min(12).max(144).default(36), left: z.number().min(12).max(144).default(36) }).strict().default({ top: 36, right: 36, bottom: 36, left: 36 }),
}).strict();
export const reportDefinitionSchema = z.object({
  version: z.literal(1),
  page: reportPageSchema,
  header: z.object({ title: z.string().max(200).default(""), subtitle: z.string().max(500).default(""), text: z.string().max(2_000).default(""), showRunDate: z.boolean().default(true), showParameters: z.boolean().default(true) }).strict(),
  footer: z.object({ text: z.string().max(500).default(""), showPageNumbers: z.boolean().default(true) }).strict(),
  parameters: z.array(reportParameterSchema).max(32).default([]),
  items: z.array(reportItemSchema).max(60),
  retentionCount: z.number().int().min(1).max(1_000).default(20),
}).strict().superRefine((definition, context) => {
  const ids = new Set<string>();
  definition.items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["items", index, "id"], message: "Each report item must have a unique ID." });
    ids.add(item.id);
    if (item.type === "table" && new Set(item.columns.map((column) => column.id)).size !== item.columns.length)
      context.addIssue({ code: "custom", path: ["items", index, "columns"], message: "Table column IDs must be unique." });
  });
  const parameters = new Map(definition.parameters.map((parameter) => [parameter.id, parameter]));
  if (parameters.size !== definition.parameters.length) context.addIssue({ code: "custom", path: ["parameters"], message: "Parameter IDs must be unique." });
  definition.parameters.forEach((parameter, index) => {
    const visited = new Set([parameter.id]);
    let dependency = parameter.dependsOn;
    while (dependency) {
      if (!parameters.has(dependency)) { context.addIssue({ code: "custom", path: ["parameters", index, "dependsOn"], message: "Choose an existing parent parameter." }); break; }
      if (visited.has(dependency)) { context.addIssue({ code: "custom", path: ["parameters", index, "dependsOn"], message: "Parameter dependencies cannot form a cycle." }); break; }
      visited.add(dependency); dependency = parameters.get(dependency)?.dependsOn;
    }
  });
});
export const reportDocumentSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2_000).default(""), definition: reportDefinitionSchema }).strict();
export const savedReportSchema = reportDocumentSchema.extend({ id: z.string().uuid(), projectId: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type ReportFormat = z.infer<typeof reportFormatSchema>;
export type ReportParameter = z.infer<typeof reportParameterSchema>;
export type ReportParameterValue = z.infer<typeof reportParameterValueSchema>;
export type ReportParameterValues = z.infer<typeof reportParameterValuesSchema>;
export type ReportDataSource = z.infer<typeof reportDataSourceSchema>;
export type ReportColumn = z.infer<typeof reportColumnSchema>;
export type ReportConditionalFormat = z.infer<typeof reportConditionalFormatSchema>;
export type ReportTable = z.infer<typeof reportTableSchema>;
export type ReportMatrix = z.infer<typeof reportMatrixSchema>;
export type ReportChart = z.infer<typeof reportChartSchema>;
export type ReportItem = z.infer<typeof reportItemSchema>;
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportDocument = z.infer<typeof reportDocumentSchema>;
export type SavedReport = z.infer<typeof savedReportSchema>;
export function createEmptyReport(name = "Untitled report"): ReportDocument {
  return reportDocumentSchema.parse({ name, description: "", definition: { version: 1, page: { size: "A4", orientation: "portrait", margins: { top: 36, right: 36, bottom: 36, left: 36 } }, header: { title: name, subtitle: "", text: "", showRunDate: true, showParameters: true }, footer: { text: "", showPageNumbers: true }, parameters: [], items: [], retentionCount: 20 } });
}
