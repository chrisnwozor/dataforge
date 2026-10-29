import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SQLOutputValue } from "node:sqlite";
import type {
  RejectedRow,
  RunDetail,
  RunLog,
  RunLogLevel,
  RunOptions,
  RunRecord,
  RunStatus,
  RunStep,
  RunStepStatus,
} from "@/lib/runner/types";
import { isTerminalRun } from "@/lib/runner/types";
import { getDatabase, withTransaction } from "./db";
import { HttpError } from "./http";
import { findProject } from "./projects";
import { pipelineSummarySchema } from "./prepare-storage";

const storedOptionsSchema = z
  .object({
    incremental: z.boolean(),
    dedupe: z.boolean(),
    db: z.string().min(1).max(128),
  })
  .strict();
const statuses = new Set<RunStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const stepStatuses = new Set<RunStepStatus>([...statuses, "skipped"]);
type Row = Record<string, SQLOutputValue>;

function runFromRow(row: Row): RunRecord {
  const status = String(row.status) as RunStatus;
  if (
    !statuses.has(status) ||
    (row.mode !== "full" && row.mode !== "incremental")
  )
    throw new HttpError(500, "A saved run has an invalid state.");
  const options = storedOptionsSchema.safeParse(
    JSON.parse(String(row.options_json)),
  );
  if (!options.success)
    throw new HttpError(500, "A saved run has invalid options.");
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status,
    mode: row.mode,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    rowsStaged: Number(row.rows_staged),
    rowsLoaded: Number(row.rows_loaded),
    rowsRejected: Number(row.rows_rejected),
    errorFile: row.error_file === null ? null : String(row.error_file),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    errorBatch: row.error_batch === null ? null : Number(row.error_batch),
    errorNumber: row.error_number === null ? null : Number(row.error_number),
    errorLine: row.error_line === null ? null : Number(row.error_line),
    options: options.data,
    ...(row.prepare_summary ? { prepareSummary: pipelineSummarySchema.parse(JSON.parse(String(row.prepare_summary))) } : {}),
  };
}

export function getRun(runId: string): RunRecord | undefined {
  const row = getDatabase()
    .prepare("SELECT * FROM runs WHERE id = ?")
    .get(runId);
  return row ? runFromRow(row) : undefined;
}

export function listRuns(projectId: string): RunRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC, id DESC",
    )
    .all(projectId)
    .map(runFromRow);
}

export function findActiveRun(projectId: string): RunRecord | undefined {
  const row = getDatabase()
    .prepare(
      "SELECT * FROM runs WHERE project_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1",
    )
    .get(projectId);
  return row ? runFromRow(row) : undefined;
}

export function listActiveRuns(): RunRecord[] {
  return getDatabase()
    .prepare(
      "SELECT * FROM runs WHERE status IN ('queued', 'running') ORDER BY started_at ASC",
    )
    .all()
    .map(runFromRow);
}

/** Private recovery metadata is never included in a client run record. */
export function getRunOwnerPid(runId: string): number | null {
  const row = getDatabase()
    .prepare("SELECT owner_pid FROM runs WHERE id = ?")
    .get(runId);
  return row?.owner_pid == null ? null : Number(row.owner_pid);
}

/** The partial unique index is the durable per-project concurrency lock. */
export function createQueuedRun(
  projectId: string,
  options: RunOptions,
  files: readonly string[],
  id = randomUUID(),
): RunRecord {
  if (!findProject(projectId)) throw new HttpError(404, "Project not found.");
  const parsed = storedOptionsSchema.safeParse(options);
  if (!parsed.success) throw new HttpError(400, "Invalid run options.");
  const timestamp = new Date().toISOString();
  const database = getDatabase();
  try {
    withTransaction(database, () => {
      database
        .prepare(
          "INSERT INTO runs (id, project_id, status, mode, started_at, options_json, owner_pid) VALUES (?, ?, 'queued', ?, ?, ?, ?)",
        )
        .run(
          id,
          projectId,
          options.incremental ? "incremental" : "full",
          timestamp,
          JSON.stringify(parsed.data),
          process.pid,
        );
      const insertStep = database.prepare(
        "INSERT INTO run_steps (run_id, ordinal, file, status) VALUES (?, ?, ?, 'queued')",
      );
      files.forEach((file, ordinal) => insertStep.run(id, ordinal, file));
    });
  } catch (error) {
    if (findActiveRun(projectId))
      throw new HttpError(409, "A run is already active for this project.");
    throw error;
  }
  return getRun(id)!;
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  if (isTerminalRun(from)) return false;
  if (from === "queued")
    return to === "running" || to === "failed" || to === "cancelled";
  return to === "succeeded" || to === "failed" || to === "cancelled";
}

export type RunUpdate = Partial<
  Pick<
    RunRecord,
    | "status"
    | "startedAt"
    | "finishedAt"
    | "rowsStaged"
    | "rowsLoaded"
    | "rowsRejected"
    | "errorFile"
    | "errorMessage"
    | "errorBatch"
    | "errorNumber"
    | "errorLine"
  >
>;

export function updateRun(runId: string, patch: RunUpdate): RunRecord {
  const database = getDatabase();
  return withTransaction(database, () => {
    const existing = getRun(runId);
    if (!existing) throw new HttpError(404, "Run not found.");
    const next = { ...existing, ...patch };
    if (
      !statuses.has(next.status) ||
      !canTransitionRun(existing.status, next.status)
    )
      throw new HttpError(
        409,
        `A ${existing.status} run cannot become ${next.status}.`,
      );
    if (
      [next.rowsStaged, next.rowsLoaded, next.rowsRejected].some(
        (value) => !Number.isSafeInteger(value) || value < 0,
      )
    )
      throw new HttpError(400, "Run row counts must be nonnegative integers.");
    if (isTerminalRun(next.status) && !next.finishedAt)
      next.finishedAt = new Date().toISOString();
    database
      .prepare(
        `
      UPDATE runs SET status = ?, started_at = ?, finished_at = ?, rows_staged = ?, rows_loaded = ?, rows_rejected = ?,
      error_file = ?, error_message = ?, error_batch = ?, error_number = ?, error_line = ? WHERE id = ?
    `,
      )
      .run(
        next.status,
        next.startedAt,
        next.finishedAt,
        next.rowsStaged,
        next.rowsLoaded,
        next.rowsRejected,
        next.errorFile,
        next.errorMessage,
        next.errorBatch,
        next.errorNumber,
        next.errorLine,
        runId,
      );
    if (isTerminalRun(next.status))
      database
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(next.finishedAt!, next.projectId);
    return getRun(runId)!;
  });
}

export function transitionRun(
  runId: string,
  status: RunStatus,
  patch: Omit<RunUpdate, "status"> = {},
): RunRecord {
  return updateRun(runId, { ...patch, status });
}

export type RunStepUpdate = Partial<
  Pick<
    RunStep,
    "status" | "startedAt" | "finishedAt" | "rowsAffected" | "message"
  >
>;

function stepFromRow(row: Row): RunStep {
  const status = String(row.status) as RunStepStatus;
  if (!stepStatuses.has(status))
    throw new HttpError(500, "A saved run step has an invalid state.");
  return {
    runId: String(row.run_id),
    ordinal: Number(row.ordinal),
    file: String(row.file),
    status,
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    rowsAffected: Number(row.rows_affected),
    message: row.message === null ? null : String(row.message),
  };
}

export function updateStep(
  runId: string,
  ordinal: number,
  patch: RunStepUpdate,
): RunStep {
  const database = getDatabase();
  const row = database
    .prepare("SELECT * FROM run_steps WHERE run_id = ? AND ordinal = ?")
    .get(runId, ordinal);
  if (!row) throw new HttpError(404, "Run step not found.");
  const existing = stepFromRow(row);
  const next = { ...existing, ...patch };
  if (
    !stepStatuses.has(next.status) ||
    ((existing.status === "succeeded" ||
      existing.status === "failed" ||
      existing.status === "cancelled" ||
      existing.status === "skipped") &&
      next.status !== existing.status) ||
    (next.status === "queued" && existing.status !== "queued")
  )
    throw new HttpError(
      409,
      `A ${existing.status} step cannot become ${next.status}.`,
    );
  if (!Number.isSafeInteger(next.rowsAffected) || next.rowsAffected < 0)
    throw new HttpError(400, "Step row counts must be nonnegative integers.");
  if (next.status === "running" && !next.startedAt)
    next.startedAt = new Date().toISOString();
  if (next.status !== "queued" && next.status !== "running" && !next.finishedAt)
    next.finishedAt = new Date().toISOString();
  database
    .prepare(
      "UPDATE run_steps SET status = ?, started_at = ?, finished_at = ?, rows_affected = ?, message = ? WHERE run_id = ? AND ordinal = ?",
    )
    .run(
      next.status,
      next.startedAt,
      next.finishedAt,
      next.rowsAffected,
      next.message,
      runId,
      ordinal,
    );
  return next;
}

export function appendLog(
  runId: string,
  level: RunLogLevel,
  message: string,
  ts = new Date().toISOString(),
): RunLog {
  const result = getDatabase()
    .prepare(
      "INSERT INTO run_logs (run_id, ts, level, message) VALUES (?, ?, ?, ?)",
    )
    .run(runId, ts, level, message);
  return { id: Number(result.lastInsertRowid), runId, ts, level, message };
}

export function saveRejectedRows(
  runId: string,
  rows: readonly RejectedRow[],
): void {
  const database = getDatabase();
  withTransaction(database, () => {
    database.prepare("DELETE FROM run_reject_rows WHERE run_id = ?").run(runId);
    const insert = database.prepare(
      "INSERT INTO run_reject_rows (run_id, ordinal, source_row_number, reason, raw_json) VALUES (?, ?, ?, ?, ?)",
    );
    rows
      .slice(0, 100)
      .forEach((row, ordinal) =>
        insert.run(
          runId,
          ordinal,
          row.sourceRowNumber,
          row.reason,
          row.rawJson,
        ),
      );
  });
}

export function getRunDetail(runId: string): RunDetail | undefined {
  const run = getRun(runId);
  if (!run) return undefined;
  const database = getDatabase();
  const steps = database
    .prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal ASC")
    .all(runId)
    .map(stepFromRow);
  const logs = database
    .prepare(
      "SELECT id, run_id, ts, level, message FROM run_logs WHERE run_id = ? ORDER BY id ASC",
    )
    .all(runId)
    .map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      ts: String(row.ts),
      level: String(row.level) as RunLogLevel,
      message: String(row.message),
    }));
  const rejected = database
    .prepare(
      "SELECT source_row_number, reason, raw_json FROM run_reject_rows WHERE run_id = ? ORDER BY ordinal ASC LIMIT 100",
    )
    .all(runId)
    .map((row) => ({
      sourceRowNumber: Number(row.source_row_number),
      reason: String(row.reason),
      rawJson: String(row.raw_json),
    }));
  return { run, steps, logs, rejected };
}
