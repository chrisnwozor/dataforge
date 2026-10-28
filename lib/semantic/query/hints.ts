/** Bound parallel worker use and workspace memory for concurrent interactive workloads. */
export const QUERY_PLAN_HINTS = "OPTION (MAXDOP 2, MAX_GRANT_PERCENT = 10)";

export function withQueryPlanHints(statement: string): string {
  return `${statement.trim().replace(/;$/, "")}\n${QUERY_PLAN_HINTS};`;
}
