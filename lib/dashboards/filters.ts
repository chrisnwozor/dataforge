import { createEmptyView, sameAttribute, type ViewConfig } from "@/lib/explore/config";
import type { AttributeRef, QueryFilter, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticColumn, SemanticModel, SemanticTable } from "@/lib/semantic/types";
import type { SavedExploreView } from "@/lib/server/explore-views";
import type { DashboardTile } from "./schema";

export type DashboardSavedView = Pick<SavedExploreView, "id" | "config">;

/** Saved charts use the current view definition so an edited view changes its tiles. */
export function resolveTileView(tile: DashboardTile, views: readonly DashboardSavedView[] = []): ViewConfig | null {
  if (tile.type === "chart") {
    const source = tile.source;
    return source.kind === "inline" ? source.config : views.find((view) => view.id === source.viewId)?.config ?? null;
  }
  if (tile.type !== "kpi") return null;
  const config = createEmptyView();
  return {
    ...config,
    viz: "kpi",
    values: [tile.measure, ...(tile.comparisonMeasure && tile.comparisonMeasure !== tile.measure ? [tile.comparisonMeasure] : [])],
    options: { ...config.options, title: tile.title, numberFormat: tile.numberFormat, showLegend: tile.showLegend },
  };
}

const fold = (value: string) => value.trim().toLocaleLowerCase("en-US");
function resolveAttribute(model: SemanticModel, attribute: AttributeRef): { table: SemanticTable; column: SemanticColumn } | null {
  const exactTable = model.tables.find((table) => table.id === attribute.table);
  const tables = exactTable ? [exactTable] : model.tables.filter((table) => fold(table.name) === fold(attribute.table) || fold(table.sqlName) === fold(attribute.table));
  if (tables.length !== 1) return null;
  const table = tables[0];
  const exactColumn = table.columns.find((column) => column.id === attribute.column);
  const columns = exactColumn ? [exactColumn] : table.columns.filter((column) => fold(column.name) === fold(attribute.column) || fold(column.sqlName) === fold(attribute.column));
  return columns.length === 1 && columns[0].role === "attribute" ? { table, column: columns[0] } : null;
}

/** Dimensions are shared through fact relationships, regardless of a tile's grouping axes. */
export function reachableTableIds(model: SemanticModel): Set<string> {
  const reachable = new Set([model.factTableId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relationship of model.relationships) {
      if (reachable.has(relationship.fromTableId) && !reachable.has(relationship.toTableId)) {
        reachable.add(relationship.toTableId);
        changed = true;
      }
    }
  }
  return reachable;
}

export function attributeAppliesToTile(tile: DashboardTile, model: SemanticModel, attribute: AttributeRef, views: readonly DashboardSavedView[] = []): boolean {
  const config = resolveTileView(tile, views);
  if (!config?.values.length || !config.values.every((id) => model.measures.some((measure) => measure.id === id || fold(measure.name) === fold(id)))) return false;
  const resolved = resolveAttribute(model, attribute);
  return resolved !== null && reachableTableIds(model).has(resolved.table.id);
}

/** Unknown/disconnected attributes never enter a tile query. Return canonical IDs. */
export function applicableFilters(tile: DashboardTile, model: SemanticModel, filters: readonly QueryFilter[], views: readonly DashboardSavedView[] = []): QueryFilter[] {
  return filters.flatMap((filter) => {
    if (!attributeAppliesToTile(tile, model, filter.attribute, views)) return [];
    const resolved = resolveAttribute(model, filter.attribute)!;
    return [{ ...filter, attribute: { table: resolved.table.id, column: resolved.column.id } }];
  });
}

export function affectedTileIds(model: SemanticModel, tiles: readonly DashboardTile[], filter: QueryFilter | AttributeRef, views: readonly DashboardSavedView[] = []): string[] {
  const attribute = "attribute" in filter ? filter.attribute : filter;
  return tiles.filter((tile) => attributeAppliesToTile(tile, model, attribute, views)).map((tile) => tile.id);
}

/** Same-value clicks clear that attribute; another member replaces its prior selection. */
export function toggleCrossFilter(filters: readonly QueryFilter[], attribute: AttributeRef, value: QueryValue): QueryFilter[] {
  const op = value === null ? "isNull" : "eq";
  const selected = filters.some((filter) => sameAttribute(filter.attribute, attribute) && filter.op === op && (value === null || Object.is(filter.value, value)));
  const remaining = filters.filter((filter) => !sameAttribute(filter.attribute, attribute));
  return selected ? remaining : [...remaining, value === null ? { attribute, op: "isNull" } : { attribute, op: "eq", value }];
}

/** View and dashboard filters intersect. Identical constraints are sent only once. */
export function mergeDashboardFilters(baseFilters: readonly QueryFilter[], dashboardFilters: readonly QueryFilter[]): QueryFilter[] {
  const known = new Set<string>();
  return [...baseFilters, ...dashboardFilters].filter((filter) => {
    const key = JSON.stringify({ attribute: [filter.attribute.table, filter.attribute.column], op: filter.op, value: filter.value, values: filter.values ? [...filter.values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : undefined });
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
}
