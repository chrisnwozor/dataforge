import { attributeKey } from "@/lib/explore/config";
import type { ViewConfig } from "@/lib/explore/config";
import type { AttributeRef, QueryFilter, QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { reportParameterFilters } from "./parameters";
import { reportDefinitionSchema, type ReportDataSource, type ReportDefinition, type ReportItem, type ReportParameterValues } from "./schema";

export interface ReportSavedView { id: string; config: ViewConfig }
export interface ReportTotalQuery { key: string; groupBy: AttributeRef[]; query: SemanticQuery }
export interface ReportItemQueryPlan { itemId: string; main: SemanticQuery; totals: ReportTotalQuery[] }
export interface ReportItemData { result: QueryResult; rows?: AttributeRef[]; measures?: string[]; totals?: { key: string; groupBy: AttributeRef[]; result: QueryResult }[] }
export interface ReportExecutionData { items: Record<string, ReportItemData>; parameters: ReportParameterValues; runAt: string }
const distinct = <T,>(values: readonly T[], key: (value: T) => string): T[] => [...new Map(values.map((value) => [key(value), value])).values()];
const refs = (values: readonly AttributeRef[]): AttributeRef[] => distinct(values, attributeKey);
const measures = (values: readonly string[]): string[] => [...new Set(values)];

export function resolveReportDataSource(source: ReportDataSource, views: readonly ReportSavedView[]): Omit<SemanticQuery, "limit" | "hideUnknown"> {
  if (source.kind === "fields") return { measures: source.values, rows: source.rows, filters: source.filters, orderBy: source.sort, ...(source.topN ? { topN: source.topN } : {}) };
  const view = views.find((entry) => entry.id === source.viewId)?.config;
  if (!view) throw new Error("A saved Explore view used by this report is unavailable. Choose a view from this project.");
  return { measures: view.values, rows: view.rows, columns: view.columns, filters: view.filters, orderBy: view.sort, ...(view.topN ? { topN: view.topN } : {}) };
}
function mergeFilters(fixed: QueryFilter[], parameters: QueryFilter[]): QueryFilter[] {
  return distinct([...fixed, ...parameters], (filter) => JSON.stringify(filter));
}
function groupKey(groupBy: AttributeRef[]): string { return groupBy.length ? JSON.stringify(groupBy) : "grand"; }
export const reportGroupKey = groupKey;

/** Plan separate server contexts for every subtotal. Ratios/averages are never summed client-side. */
export function planReportQueries(input: ReportDefinition, parameters: ReportParameterValues = {}, views: readonly ReportSavedView[] = [], model?: SemanticModel): ReportItemQueryPlan[] {
  const definition = reportDefinitionSchema.parse(input);
  const parameterFilters = reportParameterFilters(definition, parameters, model);
  const plans = definition.items.flatMap((item): ReportItemQueryPlan[] => {
    if (!("data" in item)) return [];
    const source = resolveReportDataSource(item.data, views);
    const rows = itemRows(item, item.type === "table" ? [...source.rows, ...(source.columns ?? [])] : source.rows);
    const columns = item.type === "matrix" ? item.columns : item.type === "table" ? [] : source.columns ?? [];
    const values = item.type === "table" ? measures([...source.measures, ...item.columns.flatMap((column) => column.binding.kind === "measure" ? [column.binding.measure] : []), ...(item.topNPerGroup ? [item.topNPerGroup.measure] : [])]) : item.type === "matrix" ? item.values : source.measures;
    if (!values.length) throw new Error(`Choose a measure for ${item.title || "this report item"}.`);
    if (rows.length + columns.length > 12) throw new Error("Choose at most twelve grouping attributes for a report item.");
    const orderBy = source.orderBy.filter((order) => typeof order.ref === "string" ? values.includes(order.ref) : [...rows, ...columns].some((ref) => attributeKey(ref) === attributeKey(order.ref as AttributeRef)));
    // Keep grouped members adjacent so headers, keep-together and per-group Top N are deterministic.
    const groups = item.type === "table" ? item.groups : item.type === "matrix" ? item.rows : [];
    const groupOrder = groups.map((ref) => ({ ref, dir: "asc" as const }));
    const sort = [...groupOrder, ...orderBy.filter((order) => typeof order.ref === "string" || !groups.some((ref) => attributeKey(ref) === attributeKey(order.ref as AttributeRef)))];
    const main: SemanticQuery = { measures: values, rows, columns, filters: mergeFilters(source.filters, parameterFilters), orderBy: sort.length ? sort : rows.map((ref) => ({ ref, dir: "asc" as const })), limit: 100_000, report: true, hideUnknown: true, ...(source.topN && !(item.type === "table" && item.topNPerGroup) ? { topN: { ...source.topN, n: Math.min(source.topN.n, 100_000) } } : {}) };
    const totals: ReportTotalQuery[] = [];
    const addTotal = (groupBy: AttributeRef[]) => {
      const key = groupKey(groupBy);
      if (totals.some((total) => total.key === key)) return;
      totals.push({ key, groupBy, query: { measures: values, rows: groupBy, columns: [], filters: main.filters, orderBy: groupBy.map((ref) => ({ ref, dir: "asc" })), limit: 100_000, report: true, hideUnknown: true } });
    };
    if (item.type === "table") {
      if (item.subtotals) for (let depth = 1; depth <= groups.length; depth++) addTotal(groups.slice(0, depth));
      if (item.grandTotal) addTotal([]);
    } else if (item.type === "matrix") {
      if (item.subtotals) {
        for (let depth = 1; depth <= item.rows.length; depth++) {
          addTotal(item.rows.slice(0, depth));
          addTotal(refs([...item.rows.slice(0, depth), ...item.columns]));
        }
      }
      if (item.grandTotal) { addTotal(item.columns); addTotal([]); }
    }
    return [{ itemId: item.id, main, totals }];
  });
  // Equal grouping/filter/sort contexts share one SQL request containing the union of measures.
  // Every consuming item still binds by semantic measure name/id rather than column ordinal.
  const shared = new Map<string, SemanticQuery[]>();
  for (const plan of plans) for (const query of [plan.main, ...plan.totals.map((total) => total.query)]) {
    const key = JSON.stringify({ ...query, measures: undefined });
    const existing = shared.get(key) ?? []; existing.push(query); shared.set(key, existing);
  }
  for (const queries of shared.values()) {
    const combined = measures(queries.flatMap((query) => query.measures));
    if (combined.length > 64) throw new Error("A shared report grouping may contain at most 64 measures.");
    queries.forEach((query) => { query.measures = combined; });
  }
  return plans;
}
function itemRows(item: ReportItem, source: AttributeRef[]): AttributeRef[] {
  if (item.type === "matrix") return refs(item.rows);
  if (item.type === "table") return refs([...item.groups, ...source, ...item.columns.flatMap((column) => column.binding.kind === "attribute" ? [column.binding.attribute] : [])]);
  return refs(source);
}
