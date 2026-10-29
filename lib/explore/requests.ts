import { toSemanticQuery, type ViewConfig } from "./config";
import type { QueryResult, SemanticQuery } from "@/lib/semantic/query/types";

export interface ExploreTotals {
  rows?: QueryResult;
  columns?: QueryResult;
  grand?: QueryResult;
}
export interface ExploreRequestPlan {
  query: SemanticQuery;
  totals: { key: keyof ExploreTotals; query: SemanticQuery }[];
}

/** Totals are their own semantic queries: ratios, DISTINCTCOUNT and AVG cannot be added. */
export function buildExploreRequests(config: ViewConfig): ExploreRequestPlan {
  const query = toSemanticQuery(config);
  // A KPI is a value in the full filter context, never an arbitrary first grouped row.
  if (config.viz === "kpi") {
    query.rows = [];
    query.columns = [];
    query.orderBy = [];
    query.topN = undefined;
  }
  if (!config.options.showTotals || config.viz !== "pivot")
    return { query, totals: [] };
  const base = { ...query, topN: undefined, orderBy: [] };
  const totals: ExploreRequestPlan["totals"] = [
    { key: "rows", query: { ...base, rows: config.rows, columns: [] } },
    { key: "columns", query: { ...base, rows: [], columns: config.columns } },
    { key: "grand", query: { ...base, rows: [], columns: [] } },
  ];
  return { query, totals };
}
