import { z } from "zod";
import { attributeRefSchema, queryFilterSchema } from "@/lib/semantic/query/schema";
import type { AttributeRef, QueryFilter, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";

export const visualizationSchema = z.enum(["table", "pivot", "bar", "line", "area", "donut", "kpi"]);
const reference = z.string().min(1).max(256);
export const viewOptionsSchema = z.object({
  title: z.string().max(200).default(""),
  numberFormat: z.enum(["auto", "number", "currency", "percent", "decimals"]).default("auto"),
  showTotals: z.boolean().default(true),
  seriesColors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(64).default([]),
  barOrientation: z.enum(["vertical", "horizontal"]).default("vertical"),
  stacked: z.boolean().default(false),
  showLegend: z.boolean().default(true),
}).strict();

/** Persisted format. Unknown versions are rejected rather than silently losing settings. */
export const viewConfigSchema = z.object({
  version: z.literal(1),
  viz: visualizationSchema,
  rows: z.array(attributeRefSchema).max(12),
  columns: z.array(attributeRefSchema).max(4),
  values: z.array(reference).max(64),
  filters: z.array(queryFilterSchema).max(64),
  sort: z.array(z.object({ ref: z.union([reference, attributeRefSchema]), dir: z.enum(["asc", "desc"]) }).strict()).max(12),
  topN: z.object({ measure: reference, n: z.number().int().min(1).max(50_000) }).strict().optional(),
  options: viewOptionsSchema,
}).strict().superRefine((value, context) => {
  if (value.rows.length + value.columns.length > 12)
    context.addIssue({ code: "custom", path: ["rows"], message: "Choose at most 12 grouping attributes." });
  const fields = [...value.rows, ...value.columns].map(attributeKey);
  if (new Set(fields).size !== fields.length)
    context.addIssue({ code: "custom", path: ["rows"], message: "Each attribute can appear on only one shelf." });
  if (new Set(value.values).size !== value.values.length)
    context.addIssue({ code: "custom", path: ["values"], message: "Each measure can appear only once." });
});

export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type Visualization = ViewConfig["viz"];
export type ExploreShelf = "rows" | "columns" | "values";
export const attributeKey = (attribute: AttributeRef): string => JSON.stringify([attribute.table, attribute.column]);
export const sameAttribute = (left: AttributeRef, right: AttributeRef): boolean => attributeKey(left) === attributeKey(right);

/** A shelf edit must not leave a sort or Top N referring to a removed field. */
export function pruneViewOrder(view: ViewConfig): ViewConfig {
  const attributes = [...view.rows, ...view.columns];
  const sort = view.sort.filter((item) => typeof item.ref === "string"
    ? view.values.includes(item.ref) || attributes.some((attribute) => attribute.column === item.ref)
    : attributes.some((attribute) => sameAttribute(attribute, item.ref as AttributeRef)));
  const topN = view.topN && view.values.includes(view.topN.measure) ? view.topN : undefined;
  return { ...view, sort, topN };
}

export function createEmptyView(): ViewConfig {
  return { version: 1, viz: "table", rows: [], columns: [], values: [], filters: [], sort: [], options: viewOptionsSchema.parse({}) };
}

export function createStarterView(model: SemanticModel): ViewConfig {
  const view = createEmptyView();
  const measure = model.measures.find((item) => /^\s*SUM\s*\(/i.test(item.expression)) ?? model.measures[0];
  const table = model.tables.find((item) => item.kind === "dimension" && item.columns.some((column) => column.role === "attribute"));
  const column = table?.columns.find((item) => item.role === "attribute");
  return { ...view, values: measure ? [measure.id] : [], rows: table && column ? [{ table: table.id, column: column.id }] : [] };
}

export type ExploreAction =
  | { type: "replace"; config: ViewConfig }
  | { type: "viz"; viz: Visualization }
  | { type: "add"; shelf: ExploreShelf; field: AttributeRef | string; index?: number }
  | { type: "remove"; shelf: ExploreShelf; index: number }
  | { type: "move"; from: ExploreShelf; to: ExploreShelf; index: number; targetIndex?: number }
  | { type: "filters"; filters: QueryFilter[] }
  | { type: "sort"; sort: ViewConfig["sort"] }
  | { type: "topN"; topN?: ViewConfig["topN"] }
  | { type: "options"; options: Partial<ViewConfig["options"]> };

function addField(view: ViewConfig, shelf: ExploreShelf, field: AttributeRef | string, index?: number): ViewConfig {
  if (shelf === "values") {
    if (typeof field !== "string" || view.values.includes(field)) return view;
    const values = [...view.values];
    values.splice(index ?? values.length, 0, field);
    return { ...view, values };
  }
  if (typeof field === "string") return view;
  const rows = view.rows.filter((item) => !sameAttribute(item, field));
  const columns = view.columns.filter((item) => !sameAttribute(item, field));
  const list = shelf === "rows" ? rows : columns;
  list.splice(index ?? list.length, 0, field);
  return { ...view, rows, columns };
}

export function viewReducer(view: ViewConfig, action: ExploreAction): ViewConfig {
  let next: ViewConfig;
  switch (action.type) {
    case "replace": next = action.config; break;
    case "viz": next = { ...view, viz: action.viz }; break;
    case "add": next = addField(view, action.shelf, action.field, action.index); break;
    case "remove": next = pruneViewOrder({ ...view, [action.shelf]: view[action.shelf].filter((_, index) => index !== action.index) }); break;
    case "move": {
      const field = view[action.from][action.index];
      if (field === undefined || (action.from === "values") !== (action.to === "values")) return view;
      const without = { ...view, [action.from]: view[action.from].filter((_, index) => index !== action.index) };
      next = addField(without, action.to, field, action.targetIndex);
      break;
    }
    case "filters": next = { ...view, filters: action.filters }; break;
    case "sort": next = { ...view, sort: action.sort }; break;
    case "topN": next = { ...view, topN: action.topN }; break;
    case "options": next = { ...view, options: { ...view.options, ...action.options } }; break;
    default: return view;
  }
  // UI gestures crossing a bound are harmless; persisted/server input uses parse and reports errors.
  const parsed = viewConfigSchema.safeParse(next);
  return parsed.success ? parsed.data : view;
}

export function toSemanticQuery(view: ViewConfig): SemanticQuery {
  return { measures: view.values, rows: view.rows, columns: view.columns, filters: view.filters, orderBy: view.sort, topN: view.topN, limit: 50_000, hideUnknown: true };
}
