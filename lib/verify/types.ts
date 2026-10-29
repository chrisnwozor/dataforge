import type { SemanticModel, SqlParameter } from "@/lib/semantic/types";
import type {
  QueryResult,
  QueryResultColumn,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
export type CheckArea = "Ingestion" | "Semantic" | "Reports" | "Dashboards";
export type CheckStatus = "pass" | "warn" | "fail" | "skipped";
export type CheckValue =
  | string
  | number
  | boolean
  | null
  | CheckValue[]
  | { [key: string]: CheckValue };
export interface CheckOutcome {
  status: CheckStatus;
  expected: CheckValue;
  actual: CheckValue;
  difference: number | null;
  tolerance: number;
  explanation: string;
  nextStep: string;
  sql: string;
  referenceSql?: string;
}
export interface CheckResult extends CheckOutcome {
  id: string;
  area: CheckArea;
  name: string;
  elapsedMs: number;
}
export interface CheckCase {
  id: string;
  area: CheckArea;
  name: string;
  run(signal: AbortSignal): Promise<CheckOutcome>;
}
export interface ReferenceSql {
  sql: string;
  params: SqlParameter[];
  columns: QueryResultColumn[];
  limit: number;
}
export type ReferenceRows = Record<string, QueryValue>[];
export type ReferenceExecutor = (
  query: ReferenceSql,
  signal: AbortSignal,
) => Promise<ReferenceRows>;
export type EngineExecutor = (
  query: SemanticQuery,
  signal: AbortSignal,
) => Promise<QueryResult>;
export interface NumericReference {
  count: number;
  nulls: number;
  sum: number;
  min: number | null;
  max: number | null;
}
export interface PreparedColumnReference {
  name: string;
  type: "integer" | "decimal" | "date" | "boolean" | "text";
  nulls: number;
  distinct: number;
  min: string | number | null;
  max: string | number | null;
  numeric?: NumericReference;
}
export interface PreparedReference {
  rows: number;
  duplicateRows: number;
  uniqueRows: number;
  nullCells: number;
  columns: PreparedColumnReference[];
  distinctTuples: Record<string, number>;
  elapsedMs: number;
  warnings: string[];
  /** A separate aggregate over exactly-once rows, for generator dedupe reconciliation. */
  deduplicatedColumns: PreparedColumnReference[];
}
export interface VerificationColumn {
  id: string;
  name: string;
  type: PreparedColumnReference["type"];
}
export interface WarehouseLoadReference {
  id: string;
  mode: "full" | "incremental";
  rowsStaged: number;
  rowsLoaded: number;
  rowsRejected: number;
  dedupe: boolean;
  finishedAt: string | null;
}
export interface SemanticCheckInput {
  model: SemanticModel;
  engine: EngineExecutor;
  reference: ReferenceExecutor;
  attributeLimit?: number;
}
export interface CheckCounts {
  pass: number;
  warn: number;
  fail: number;
  skipped: number;
}
export interface CheckRun {
  id: string;
  projectId: string;
  workspaceId: string;
  sourceRunId: string | null;
  modelVersion: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  trigger: "manual" | "load";
  startedAt: string;
  finishedAt: string | null;
  total: number;
  completed: number;
  currentCheck: string | null;
  counts: CheckCounts;
  results: CheckResult[];
  error: string | null;
}
export interface CheckSettings {
  version: 1;
  autoAfterLoad: boolean;
  absoluteTolerance: number;
  relativeTolerance: number;
}
