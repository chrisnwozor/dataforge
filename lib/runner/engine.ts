import { randomUUID } from "node:crypto";
import { invalidateSemanticCache } from "@/lib/semantic/query/cache";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  friendlyConnectionError,
  getConnectionSettings,
  readPublicConnection,
  type SqlConnectionSettings,
} from "@/lib/server/connection";
import { cleanedSourceResponse } from "@/lib/server/cleaned-source";
import {
  getGeneration,
  type GenerationRequestOptions,
} from "@/lib/server/generation";
import { HttpError, projectIdSchema } from "@/lib/server/http";
import { findProject } from "@/lib/server/projects";
import {
  appendLog,
  createQueuedRun,
  findActiveRun,
  getRun,
  getRunDetail,
  getRunOwnerPid,
  listActiveRuns,
  saveRejectedRows,
  transitionRun,
  updateRun,
  updateStep,
} from "@/lib/server/runs";
import type { GeneratedFile } from "@/lib/sql/types";
import { resolveStagingPaths, type StagingPaths } from "./paths";
import { redactSecrets } from "./secrets";
import { splitSqlBatches, type SqlBatch } from "./split-go";
import { createSqlTransport, type SqlTransport } from "./sql-transport";
import {
  isTerminalRun,
  type RunDetail,
  type RunLogLevel,
  type RunRecord,
} from "./types";

export interface RunStartOptions extends GenerationRequestOptions {
  connectionUpdatedAt?: string;
}
export interface RunnerDependencies {
  createTransport: typeof createSqlTransport;
  stageSource: typeof stageCleanedSource;
}
interface Job {
  run: RunRecord;
  files: GeneratedFile[];
  batches: SqlBatch[][];
  connection: SqlConnectionSettings;
  paths: StagingPaths;
  timeoutMs: number;
  cancelled: boolean;
  abort: AbortController;
  transport?: SqlTransport;
  done: Promise<void>;
}
const globals = globalThis as typeof globalThis & {
  dataforgeRunnerJobs?: Map<string, Job>;
};
const jobs = (globals.dataforgeRunnerJobs ??= new Map());
const processStartedAt = Date.now() - process.uptime() * 1000;
const expectedFiles = [
  "00_setup.sql",
  "01_staging.sql",
  "02_dim_date.sql",
  "03_dimensions.sql",
  "04_fact.sql",
  "05_checks.sql",
];

function batchTimeout(): number {
  const configured = process.env.DATAFORGE_BATCH_TIMEOUT_MS;
  if (!configured) return 600_000;
  if (
    !/^\d+$/.test(configured) ||
    Number(configured) < 1 ||
    Number(configured) > 3_600_000
  )
    throw new HttpError(
      503,
      "DATAFORGE_BATCH_TIMEOUT_MS must be between 1 and 3,600,000 milliseconds.",
    );
  return Number(configured);
}

function safe(job: Job, message: string): string {
  const values = [job.connection.password, process.env.DATAFORGE_SECRET ?? ""];
  return redactSecrets(
    message,
    values.flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      return [value, json, json.replaceAll("/", "\\/")];
    }),
  );
}
function safeJson(job: Job, rawJson: string): string {
  const redactValue = (value: unknown): unknown => {
    if (typeof value === "string") return safe(job, value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          safe(job, key),
          redactValue(item),
        ]),
      );
    return value;
  };
  try {
    return JSON.stringify(redactValue(JSON.parse(rawJson)));
  } catch {
    return JSON.stringify({ unparsed: safe(job, rawJson) });
  }
}
function log(job: Job, level: RunLogLevel, message: string) {
  appendLog(job.run.id, level, safe(job, message).slice(0, 32_000));
}
function checkCancelled(job: Job) {
  if (job.cancelled) throw new Error("Run cancelled by the user.");
}

/** Stream the cleaned export into an atomic per-project file on the configured shared folder. */
export async function stageCleanedSource(
  projectId: string,
  paths: StagingPaths,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const information = await stat(paths.directory).catch(() => null);
  if (!information?.isDirectory())
    throw new Error(
      "The staging folder is unavailable. Create it and grant the DataForge process write permission and the SQL Server service read permission.",
    );
  const temporary = `${paths.writePath}.${runId}.tmp`;
  try {
    signal.throwIfAborted();
    const response = await cleanedSourceResponse(projectId);
    if (!response.body) throw new Error("The cleaned source export was empty.");
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
      createWriteStream(temporary, { flags: "wx", mode: 0o640 }),
      { signal },
    );
    signal.throwIfAborted();
    await rename(temporary, paths.writePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    if (signal.aborted) throw error;
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
      throw new Error(
        "DataForge cannot write the staging CSV. Grant the app process write permission to the staging folder or its DATAFORGE_STAGING_WRITE_DIR mount.",
      );
    throw error;
  }
}

/** Recover only jobs whose owning OS process has actually exited. Live workers retain their locks. */
export function recoverInterruptedRuns(): void {
  for (const run of listActiveRuns()) {
    if (jobs.has(run.id)) continue;
    const owner = getRunOwnerPid(run.id);
    if (!owner) continue;
    if (owner === process.pid) {
      // Containers often reuse PID 1 after a restart. Old records still predate
      // this process even when their numeric owner PID has been reused.
      if (Date.parse(run.startedAt) >= processStartedAt) continue;
    } else {
      try {
        process.kill(owner, 0);
        continue;
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          continue;
      }
    }
    const message =
      "The DataForge process stopped during this run. Open SQL transactions are rolled back when its connection closes; earlier completed scripts may already be committed. Review the target before running again.";
    for (const step of getRunDetail(run.id)?.steps ?? [])
      if (step.status === "queued" || step.status === "running")
        updateStep(run.id, step.ordinal, {
          status: step.status === "running" ? "failed" : "skipped",
          message,
        });
    appendLog(run.id, "ERROR", message);
    transitionRun(run.id, "failed", { errorMessage: message });
  }
}

function sqlError(error: unknown) {
  const row =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const nested =
    row.originalError && typeof row.originalError === "object"
      ? (row.originalError as Record<string, unknown>)
      : {};
  const info =
    nested.info && typeof nested.info === "object"
      ? (nested.info as Record<string, unknown>)
      : {};
  const number = Number(row.number ?? info.number);
  const line = Number(row.lineNumber ?? info.lineNumber);
  return {
    message: error instanceof Error ? error.message : String(error),
    code: String(row.code ?? ""),
    number: Number.isSafeInteger(number) ? number : null,
    line: Number.isSafeInteger(line) ? line : null,
  };
}

async function executeJob(
  job: Job,
  dependencies: RunnerDependencies,
): Promise<void> {
  let ordinal = -1;
  let batch: SqlBatch | undefined;
  let failure: unknown;
  let connected = false;
  try {
    checkCancelled(job);
    transitionRun(job.run.id, "running");
    log(
      job,
      "INFO",
      "Writing the cleaned CSV to the configured staging folder.",
    );
    await dependencies.stageSource(
      job.run.projectId,
      job.paths,
      job.run.id,
      job.abort.signal,
    );
    checkCancelled(job);
    log(
      job,
      "INFO",
      "Cleaned CSV is ready. Connecting with SQL authentication.",
    );
    const transport = dependencies.createTransport(
      job.connection,
      job.timeoutMs,
      (info) => {
        log(
          job,
          (info.class ?? 0) > 0 ? "WARN" : "INFO",
          `${info.message}${info.number ? ` (SQL ${info.number})` : ""}`,
        );
      },
    );
    job.transport = transport;
    await transport.connect();
    connected = true;
    checkCancelled(job);
    for (ordinal = 0; ordinal < job.files.length; ordinal++) {
      checkCancelled(job);
      const file = job.files[ordinal];
      updateStep(job.run.id, ordinal, { status: "running" });
      log(job, "INFO", `Starting ${file.name}.`);
      let affected = 0;
      for (batch of job.batches[ordinal]) {
        checkCancelled(job);
        log(
          job,
          "INFO",
          `${file.name}, batch ${batch.batchNumber}: executing.`,
        );
        const result = await transport.batch(batch.sql);
        checkCancelled(job);
        const count = result.rowsAffected.reduce(
          (sum, value) => sum + value,
          0,
        );
        affected += count;
        updateStep(job.run.id, ordinal, { rowsAffected: affected });
        log(
          job,
          "INFO",
          `${file.name}, batch ${batch.batchNumber}: ${count.toLocaleString("en-US")} rows affected.`,
        );
      }
      updateStep(job.run.id, ordinal, {
        status: "succeeded",
        rowsAffected: affected,
        message: "Completed.",
      });
      log(job, "SUCCESS", `${file.name} completed.`);
      batch = undefined;
    }
    checkCancelled(job);
    const summary = await transport.summary(job.run.id);
    checkCancelled(job);
    updateRun(job.run.id, {
      rowsStaged: summary.rowsStaged,
      rowsLoaded: summary.rowsLoaded,
      rowsRejected: summary.rowsRejected,
    });
    saveRejectedRows(
      job.run.id,
      summary.rejected.map((row) => ({
        sourceRowNumber: row.sourceRowNumber,
        reason: safe(job, row.reason),
        rawJson: safeJson(job, row.rawJson),
      })),
    );
    log(
      job,
      "SUCCESS",
      `Load completed: ${summary.rowsStaged.toLocaleString("en-US")} staged, ${summary.rowsLoaded.toLocaleString("en-US")} loaded, ${summary.rowsRejected.toLocaleString("en-US")} rejected.`,
    );
  } catch (error) {
    failure = error;
    if (connected && job.transport) {
      try {
        await job.transport.rollback();
        log(job, "INFO", "Any open SQL transaction has been rolled back.");
      } catch (rollbackFailure) {
        log(
          job,
          "WARN",
          `Rollback could not be confirmed; closing the SQL connection: ${sqlError(rollbackFailure).message}`,
        );
      }
    }
  } finally {
    // Keep the durable project lock until the in-flight request and connection cleanup finish.
    try {
      await job.transport?.close();
    } catch (closeFailure) {
      if (!failure) failure = closeFailure;
      log(job, "WARN", `Connection cleanup: ${sqlError(closeFailure).message}`);
    }
    if (job.cancelled) {
      for (const step of getRunDetail(job.run.id)?.steps ?? [])
        if (step.status === "queued" || step.status === "running")
          updateStep(job.run.id, step.ordinal, {
            status: step.status === "running" ? "cancelled" : "skipped",
            message: "Run cancelled.",
          });
      log(
        job,
        "WARN",
        "Run cancelled. Completed scripts may already be committed; open transactions were rolled back or the connection was closed.",
      );
      transitionRun(job.run.id, "cancelled");
    } else if (failure) {
      const details = sqlError(failure);
      const message =
        !connected && ordinal < 0 && job.transport
          ? friendlyConnectionError(failure, job.connection.password)
          : details.code === "ETIMEOUT"
            ? `SQL batch timed out after ${job.timeoutMs.toLocaleString("en-US")} ms. ${details.message}`
            : details.message;
      const file =
        ordinal >= 0 && ordinal < job.files.length
          ? job.files[ordinal].name
          : !job.transport
            ? "01_staging.sql"
            : null;
      const location = file
        ? `${file}${batch ? `, batch ${batch.batchNumber}` : ""}${details.line ? `, SQL line ${details.line}` : ""}: `
        : "";
      const errorMessage = safe(job, message);
      for (const step of getRunDetail(job.run.id)?.steps ?? [])
        if (step.status === "queued" || step.status === "running")
          updateStep(job.run.id, step.ordinal, {
            status:
              step.status === "running" || step.file === file
                ? "failed"
                : "skipped",
            message:
              step.status === "running" || step.file === file
                ? errorMessage
                : "Skipped after a previous failure.",
          });
      log(
        job,
        "ERROR",
        `${location}${message}${details.number !== null ? ` (SQL ${details.number})` : ""}`,
      );
      transitionRun(job.run.id, "failed", {
        errorFile: file,
        errorMessage,
        errorBatch: batch?.batchNumber ?? null,
        errorNumber: details.number,
        errorLine: details.line,
      });
    } else {
      transitionRun(job.run.id, "succeeded");
      invalidateSemanticCache(job.run.projectId);
    }
    jobs.delete(job.run.id);
    job.connection.password = "";
  }
}

/** Validate only saved/generated inputs, acquire the durable lock, then return before execution. */
export async function startRun(
  projectId: string,
  options: RunStartOptions = {},
  overrides: Partial<RunnerDependencies> = {},
): Promise<RunRecord> {
  if (!projectIdSchema.safeParse(projectId).success)
    throw new HttpError(400, "Invalid project ID.");
  recoverInterruptedRuns();
  if (!findProject(projectId)) throw new HttpError(404, "Project not found.");
  if (findActiveRun(projectId))
    throw new HttpError(409, "A run is already active for this project.");
  const publicConnection = readPublicConnection();
  if (
    options.connectionUpdatedAt !== undefined &&
    options.connectionUpdatedAt !== publicConnection.updatedAt
  )
    throw new HttpError(
      409,
      "Connection changed; review the target and confirm again.",
    );
  const connection = getConnectionSettings();
  if (options.db !== undefined && options.db.trim() !== connection.database)
    throw new HttpError(
      409,
      "The target database must match the saved connection. Review Settings and confirm the target again.",
    );
  let paths: StagingPaths;
  try {
    paths = resolveStagingPaths(
      projectId,
      connection.stagingFolder,
      process.env.DATAFORGE_STAGING_WRITE_DIR,
    );
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Invalid staging folder.",
    );
  }
  const runId = randomUUID();
  const timeoutMs = batchTimeout();
  const requested = {
    incremental: options.incremental,
    dedupe: options.dedupe,
    db: connection.database,
  };
  let generation = await getGeneration(projectId, requested, {
    runId,
    filePath: paths.sqlPath,
  });
  if (
    generation.validation.some((issue) => issue.severity === "error") ||
    !generation.files.length
  )
    throw new HttpError(
      409,
      "Resolve the model's validation errors before starting a run.",
    );
  const fallback = generation.validation.some(
    (issue) => issue.code === "incremental-without-date",
  );
  if (fallback)
    generation = await getGeneration(
      projectId,
      { ...requested, incremental: false },
      { runId, filePath: paths.sqlPath },
    );
  if (
    generation.validation.some((issue) => issue.severity === "error") ||
    !generation.files.length
  )
    throw new HttpError(
      409,
      "The model changed during run preparation. Review its validation errors before starting a run.",
    );
  if (
    generation.files.map((file) => file.name).join("|") !==
    expectedFiles.join("|")
  )
    throw new HttpError(500, "The generated execution file list is invalid.");
  const batches = generation.files.map((file) => splitSqlBatches(file.sql));
  const run = createQueuedRun(
    projectId,
    {
      incremental: generation.options.incremental,
      dedupe: generation.options.dedupe,
      db: connection.database,
    },
    expectedFiles,
    runId,
  );
  const job: Job = {
    run,
    files: generation.files,
    batches,
    connection,
    paths,
    timeoutMs,
    cancelled: false,
    abort: new AbortController(),
    done: Promise.resolve(),
  };
  jobs.set(run.id, job);
  log(
    job,
    "INFO",
    `Run queued for ${connection.server}:${connection.port}, database ${connection.database}, ${run.mode} mode.`,
  );
  if (fallback)
    log(
      job,
      "WARN",
      "No source date is available; the requested incremental load will use a full refresh.",
    );
  const dependencies = {
    createTransport: createSqlTransport,
    stageSource: stageCleanedSource,
    ...overrides,
  };
  job.done = new Promise<void>((resolve) => {
    setTimeout(() => {
      void executeJob(job, dependencies).then(
        resolve,
        (unexpected: unknown) => {
          try {
            if (!isTerminalRun(getRun(run.id)?.status ?? "failed")) {
              const message = safe(job, sqlError(unexpected).message);
              appendLog(run.id, "ERROR", message);
              transitionRun(run.id, "failed", { errorMessage: message });
            }
          } catch {
            /* Preserve process availability if local storage itself has failed. */
          } finally {
            jobs.delete(run.id);
            job.connection.password = "";
            resolve();
          }
        },
      );
    }, 0);
  });
  return run;
}

export async function cancelRun(
  projectId: string,
  runId: string,
): Promise<RunDetail> {
  const run = getRun(runId);
  if (!run || run.projectId !== projectId)
    throw new HttpError(404, "Run not found.");
  if (isTerminalRun(run.status))
    throw new HttpError(409, "This run has already finished.");
  const job = jobs.get(runId);
  if (!job) {
    recoverInterruptedRuns();
    throw new HttpError(
      409,
      "This run is not controlled by this DataForge process. Refresh its status or cancel it on the process that started it.",
    );
  }
  if (!job.cancelled) {
    job.cancelled = true;
    log(
      job,
      "WARN",
      "Cancellation requested. Waiting for the active request and transaction cleanup.",
    );
    job.abort.abort();
    job.transport?.cancel();
  }
  await job.done;
  return getRunDetail(runId)!;
}

/** Server-side helper for integration checks; HTTP clients use status/SSE endpoints. */
export async function waitForRunCompletion(runId: string): Promise<RunDetail> {
  await jobs.get(runId)?.done;
  const detail = getRunDetail(runId);
  if (!detail) throw new HttpError(404, "Run not found.");
  return detail;
}
