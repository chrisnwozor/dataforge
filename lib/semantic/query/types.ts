import type { SemanticType, SqlParameter } from "../types";
export type QueryValue = string | number | boolean | null;
export interface AttributeRef {
  table: string;
  column: string;
}
export interface QueryFilter {
  attribute: AttributeRef;
  op:
    | "eq"
    | "ne"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "notIn"
    | "isNull"
    | "isNotNull";
  value?: QueryValue;
  values?: QueryValue[];
}
export interface SemanticQuery {
  measures: string[];
  rows: AttributeRef[];
  columns?: AttributeRef[];
  filters: QueryFilter[];
  orderBy: { ref: string | AttributeRef; dir: "asc" | "desc" }[];
  limit: number;
  topN?: { measure: string; n: number };
  hideUnknown: boolean;
}
export interface QueryResultColumn {
  key: string;
  name: string;
  type: SemanticType;
  role: "attribute" | "measure";
}
export interface PivotHint {
  rowKeys: string[];
  columnKeys: string[];
  measureKeys: string[];
  columnValues: QueryValue[][];
}
export interface QueryResult {
  columns: QueryResultColumn[];
  rows: Record<string, QueryValue>[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  fromCache: boolean;
  sql: string;
  pivot?: PivotHint;
}
export interface CompiledQuery {
  sql: string;
  params: SqlParameter[];
  columns: QueryResultColumn[];
  limit: number;
  pivot?: Omit<PivotHint, "columnValues">;
}
