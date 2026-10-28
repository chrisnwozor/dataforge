import type { AttributeRef, QueryFilter, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { pruneViewOrder, sameAttribute, viewConfigSchema, type ViewConfig } from "./config";

export interface DrillStep {
  attribute: AttributeRef;
  value: QueryValue;
  nextAttribute: AttributeRef;
  previousRows: AttributeRef[];
  previousColumns: AttributeRef[];
  previousFilters: QueryFilter[];
}

export function drillThrough(config: ViewConfig, attribute: AttributeRef, value: QueryValue): ViewConfig {
  const filter: QueryFilter = value === null ? { attribute, op: "isNull" } : { attribute, op: "eq", value };
  const same = config.filters.some((item) => sameAttribute(item.attribute, attribute) && item.op === filter.op && item.value === filter.value);
  if (same) return config;
  const candidate = viewConfigSchema.safeParse({ ...config, filters: [...config.filters, filter] });
  return candidate.success ? candidate.data : config;
}

export function drillDown(config: ViewConfig, model: SemanticModel, attribute: AttributeRef, value: QueryValue): { config: ViewConfig; step: DrillStep } | null {
  const hierarchy = model.hierarchies.find((item) => item.tableId === attribute.table && item.levels.includes(attribute.column) && item.levels.indexOf(attribute.column) < item.levels.length - 1);
  if (!hierarchy) return null;
  const onRows = config.rows.some((item) => sameAttribute(item, attribute));
  const onColumns = config.columns.some((item) => sameAttribute(item, attribute));
  if (!onRows && !onColumns) return null;
  const nextAttribute = { table: attribute.table, column: hierarchy.levels[hierarchy.levels.indexOf(attribute.column) + 1] };
  const step: DrillStep = { attribute, value, nextAttribute, previousRows: config.rows, previousColumns: config.columns, previousFilters: config.filters };
  const filtered = drillThrough(config, attribute, value);
  if (filtered === config && !config.filters.some((item) => sameAttribute(item.attribute, attribute))) return null;
  const replace = (items: AttributeRef[]) => items.map((item) => sameAttribute(item, attribute) ? nextAttribute : item).filter((item, index, all) => all.findIndex((other) => sameAttribute(other, item)) === index);
  const parsed = viewConfigSchema.safeParse(pruneViewOrder({ ...filtered, rows: replace(config.rows), columns: replace(config.columns) }));
  return parsed.success ? { config: parsed.data, step } : null;
}

export function drillUp(config: ViewConfig, step: DrillStep): ViewConfig {
  return { ...config, rows: step.previousRows, columns: step.previousColumns, filters: step.previousFilters };
}
