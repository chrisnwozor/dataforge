export type RunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RunStepStatus = RunStatus | "skipped";
export type RunLogLevel = "INFO" | "WARN" | "ERROR" | "SUCCESS";
export type RunMode = "full" | "incremental";

/** Only generation choices are persisted; connection passwords never belong here. */
export interface RunOptions {
  incremental: boolean;
  dedupe: boolean;
  db: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  status: RunStatus;
  mode: RunMode;
  startedAt: string;
  finishedAt: string | null;
  rowsStaged: number;
  rowsLoaded: number;
  rowsRejected: number;
  errorFile: string | null;
  errorMessage: string | null;
  errorBatch: number | null;
  errorNumber: number | null;
  errorLine: number | null;
  options: RunOptions;
}

export interface RunStep {
  runId: string;
  ordinal: number;
  file: string;
  status: RunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  rowsAffected: number;
  message: string | null;
}

export interface RunLog {
  id: number;
  runId: string;
  ts: string;
  level: RunLogLevel;
  message: string;
}

export interface RejectedRow {
  sourceRowNumber: number;
  reason: string;
  rawJson: string;
}

export interface RunDetail {
  run: RunRecord;
  steps: RunStep[];
  logs: RunLog[];
  rejected: RejectedRow[];
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}
