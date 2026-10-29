import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentContext, requireProjectAccess } from "@/lib/auth/context";
import {
  checkCountsSchema,
  checkResultSchema,
  checkSettingsSchema,
} from "@/lib/verify/schema";
import type {
  CheckCounts,
  CheckResult,
  CheckRun,
  CheckSettings,
} from "@/lib/verify/types";
import { getDatabase, withTransaction } from "./db";
import { HttpError, projectIdSchema } from "./http";

const identity = z.string().uuid();
const timestamp = z.string().datetime();
const nullableText = (max: number) => z.string().max(max).nullable();
const status = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
const trigger = z.enum(["manual", "load"]);
const progressNumber = z.number().int().min(0).max(100_000);
const snapshotSchema = z
  .object({ version: z.literal(1), data: z.json() })
  .strict();
const patchSchema = z
  .object({
    status: status.optional(),
    total: progressNumber.optional(),
    completed: progressNumber.optional(),
    currentCheck: nullableText(1000).optional(),
    counts: checkCountsSchema.optional(),
    error: nullableText(20_000).optional(),
    modelVersion: nullableText(1024).optional(),
    sourceRunId: identity.nullable().optional(),
    finishedAt: timestamp.nullable().optional(),
  })
  .strict();
export type VerificationRunPatch = z.infer<typeof patchSchema>;
export interface CreateVerificationInput {
  sourceRunId: string | null;
  modelVersion: string | null;
  trigger: "manual" | "load";
  snapshot?: unknown;
}
const selectRun = `SELECT id, project_id AS projectId, workspace_id AS workspaceId,
  source_run_id AS sourceRunId, model_version AS modelVersion, status, trigger,
  started_at AS startedAt, finished_at AS finishedAt, total, completed,
  current_check AS currentCheck, counts_json AS countsJson, error FROM verification_runs`;
const terminal = new Set<CheckRun["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);
const transitions: Record<CheckRun["status"], CheckRun["status"][]> = {
  queued: ["queued", "running", "succeeded", "failed", "cancelled"],
  running: ["running", "succeeded", "failed", "cancelled"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};
const emptyCounts = (): CheckCounts => ({
  pass: 0,
  warn: 0,
  fail: 0,
  skipped: 0,
});
function projectAccess(projectId: string): string {
  if (!projectIdSchema.safeParse(projectId).success)
    throw new HttpError(400, "Invalid project ID.");
  return requireProjectAccess(projectId, "editor").workspaceId;
}
function checkedRunId(runId: string): string {
  const parsed = identity.safeParse(runId);
  if (!parsed.success) throw new HttpError(400, "Invalid checks run ID.");
  return parsed.data;
}
function validateSourceRun(
  projectId: string,
  workspaceId: string,
  sourceRunId: string | null,
): void {
  if (sourceRunId === null) return;
  identity.parse(sourceRunId);
  const row = getDatabase()
    .prepare(
      "SELECT status FROM runs WHERE id=? AND project_id=? AND workspace_id=?",
    )
    .get(sourceRunId, projectId, workspaceId);
  if (!row)
    throw new HttpError(404, "The load run was not found in this project.");
  if (row.status !== "succeeded")
    throw new HttpError(409, "Checks must reference a successful load.");
}
function readResults(runId: string): {
  results: CheckResult[];
  counts: CheckCounts;
} {
  const rows = getDatabase()
    .prepare(
      "SELECT ordinal,result_id AS resultId,result_json AS resultJson FROM verification_results WHERE run_id=? ORDER BY ordinal",
    )
    .all(runId);
  const counts = emptyCounts(),
    results: CheckResult[] = [],
    ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (Number(row.ordinal) !== index)
      throw new Error("The saved check results are out of order.");
    const result = checkResultSchema.parse(JSON.parse(String(row.resultJson)));
    if (row.resultId !== result.id)
      throw new Error(
        "The saved check result identity does not match its row.",
      );
    if (ids.has(result.id))
      throw new Error("The saved check results contain a repeated identity.");
    ids.add(result.id);
    counts[result.status]++;
    results.push(result);
  }
  return { results, counts };
}
function readRun(
  row: Record<string, unknown>,
  includeResults = true,
  reconcileMetadata = false,
): CheckRun {
  try {
    const id = identity.parse(row.id);
    const storedCounts = checkCountsSchema.parse(
      JSON.parse(String(row.countsJson)),
    );
    const observed = includeResults
      ? readResults(id)
      : { results: [] as CheckResult[], counts: { ...storedCounts } };
    if (!includeResults && reconcileMetadata) {
      observed.counts = emptyCounts();
      for (const aggregate of getDatabase()
        .prepare(
          "SELECT json_extract(result_json,'$.status') AS status,COUNT(*) AS n FROM verification_results WHERE run_id=? GROUP BY json_extract(result_json,'$.status')",
        )
        .all(id)) {
        const key = z
          .enum(["pass", "warn", "fail", "skipped"])
          .parse(aggregate.status);
        observed.counts[key] += Number(aggregate.n);
      }
    }
    const { results, counts } = observed;
    const completed = progressNumber.parse(row.completed),
      total = progressNumber.parse(row.total);
    if (
      (includeResults && completed !== results.length) ||
      completed !==
        Object.values(counts).reduce((sum, count) => sum + count, 0) ||
      completed > total ||
      Object.keys(counts).some(
        (key) =>
          counts[key as keyof CheckCounts] !==
          storedCounts[key as keyof CheckCounts],
      )
    )
      throw new Error("Saved check counts do not reconcile.");
    const runStatus = status.parse(row.status),
      finishedAt = timestamp.nullable().parse(row.finishedAt);
    if (
      (terminal.has(runStatus) && !finishedAt) ||
      (!terminal.has(runStatus) && finishedAt)
    )
      throw new Error("Saved check timestamps do not match their status.");
    return {
      id,
      projectId: identity.parse(row.projectId),
      workspaceId: identity.parse(row.workspaceId),
      sourceRunId: identity.nullable().parse(row.sourceRunId),
      modelVersion: nullableText(1024).parse(row.modelVersion),
      status: runStatus,
      trigger: trigger.parse(row.trigger),
      startedAt: timestamp.parse(row.startedAt),
      finishedAt,
      total,
      completed,
      currentCheck: nullableText(1000).parse(row.currentCheck),
      counts,
      results,
      error: nullableText(20_000).parse(row.error),
    };
  } catch {
    throw new HttpError(
      500,
      "A saved checks run is invalid or does not reconcile with its results. Its history has not been changed.",
    );
  }
}
function metadataRun(
  projectId: string,
  workspaceId: string,
  runId: string,
): CheckRun {
  const row = getDatabase()
    .prepare(`${selectRun} WHERE project_id=? AND workspace_id=? AND id=?`)
    .get(projectId, workspaceId, checkedRunId(runId));
  if (!row) throw new HttpError(404, "Checks run not found in this project.");
  return readRun(row, false);
}

export function getVerificationRun(projectId: string, runId: string): CheckRun {
  const workspaceId = projectAccess(projectId);
  const row = getDatabase()
    .prepare(`${selectRun} WHERE project_id=? AND workspace_id=? AND id=?`)
    .get(projectId, workspaceId, checkedRunId(runId));
  if (!row) throw new HttpError(404, "Checks run not found in this project.");
  return readRun(row);
}
export function listVerificationRuns(projectId: string): CheckRun[] {
  const workspaceId = projectAccess(projectId);
  return getDatabase()
    .prepare(
      `${selectRun} WHERE project_id=? AND workspace_id=? ORDER BY started_at DESC,id DESC LIMIT 100`,
    )
    .all(projectId, workspaceId)
    .map((row) => readRun(row, false, true));
}
export function findActiveVerificationRun(projectId: string): CheckRun | null {
  const workspaceId = projectAccess(projectId);
  const row = getDatabase()
    .prepare(
      `${selectRun} WHERE project_id=? AND workspace_id=? AND status IN ('queued','running') ORDER BY started_at DESC,id DESC LIMIT 1`,
    )
    .get(projectId, workspaceId);
  return row ? readRun(row, false, true) : null;
}
export function createVerificationRun(
  projectId: string,
  input: CreateVerificationInput,
): CheckRun {
  const workspaceId = projectAccess(projectId),
    context = currentContext();
  const parsed = z
    .object({
      sourceRunId: identity.nullable(),
      modelVersion: nullableText(1024),
      trigger,
    })
    .strict()
    .parse({
      sourceRunId: input.sourceRunId,
      modelVersion: input.modelVersion,
      trigger: input.trigger,
    });
  validateSourceRun(projectId, workspaceId, parsed.sourceRunId);
  let snapshot: string;
  try {
    snapshot = JSON.stringify(
      snapshotSchema.parse({ version: 1, data: input.snapshot ?? {} }),
    );
  } catch {
    throw new HttpError(400, "Checks require a valid JSON snapshot.");
  }
  if (Buffer.byteLength(snapshot) > 4 * 1024 * 1024)
    throw new HttpError(
      413,
      "The checks snapshot exceeds its 4 MB history limit.",
    );
  const id = randomUUID();
  try {
    getDatabase()
      .prepare(
        `INSERT INTO verification_runs (id,project_id,workspace_id,user_id,source_run_id,model_version,status,trigger,started_at,total,completed,counts_json,owner_pid,snapshot_json)
      VALUES (?,?,?,?,?,?,'queued',?,?,0,0,?,?,?)`,
      )
      .run(
        id,
        projectId,
        workspaceId,
        context.local ? null : context.user.id,
        parsed.sourceRunId,
        parsed.modelVersion,
        parsed.trigger,
        new Date().toISOString(),
        JSON.stringify(emptyCounts()),
        process.pid,
        snapshot,
      );
  } catch (error) {
    if (findActiveVerificationRun(projectId))
      throw new HttpError(
        409,
        "A checks run is already active for this project.",
      );
    throw error;
  }
  return getVerificationRun(projectId, id);
}
export function updateVerificationRun(
  projectId: string,
  runId: string,
  input: VerificationRunPatch,
): CheckRun {
  const workspaceId = projectAccess(projectId),
    parsed = patchSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid checks progress.",
    );
  const db = getDatabase();
  return withTransaction(db, () => {
    const saved = metadataRun(projectId, workspaceId, runId),
      patch = parsed.data;
    const nextStatus = patch.status ?? saved.status;
    if (!transitions[saved.status].includes(nextStatus))
      throw new HttpError(
        409,
        "This checks run has already finished or cannot enter that state.",
      );
    if (
      (patch.completed !== undefined && patch.completed !== saved.completed) ||
      (patch.counts &&
        Object.keys(saved.counts).some(
          (key) =>
            saved.counts[key as keyof CheckCounts] !==
            patch.counts![key as keyof CheckCounts],
        ))
    )
      throw new HttpError(
        400,
        "Progress and counts must reconcile with the recorded checks.",
      );
    const total = patch.total ?? saved.total;
    if (total < saved.completed)
      throw new HttpError(
        400,
        "The total cannot be smaller than the number of completed checks.",
      );
    if (nextStatus === "succeeded" && saved.completed !== total)
      throw new HttpError(
        409,
        "A checks run cannot finish successfully before every check is recorded.",
      );
    const sourceRunId =
      patch.sourceRunId === undefined ? saved.sourceRunId : patch.sourceRunId;
    validateSourceRun(projectId, workspaceId, sourceRunId);
    const finishedAt = terminal.has(nextStatus)
      ? (patch.finishedAt ?? saved.finishedAt ?? new Date().toISOString())
      : null;
    if (patch.finishedAt && !terminal.has(nextStatus))
      throw new HttpError(
        400,
        "Only a finished checks run can have a finish time.",
      );
    db.prepare(
      "UPDATE verification_runs SET status=?,source_run_id=?,model_version=?,finished_at=?,total=?,current_check=?,error=? WHERE id=? AND project_id=? AND workspace_id=?",
    ).run(
      nextStatus,
      sourceRunId,
      patch.modelVersion === undefined
        ? saved.modelVersion
        : patch.modelVersion,
      finishedAt,
      total,
      terminal.has(nextStatus)
        ? null
        : patch.currentCheck === undefined
          ? saved.currentCheck
          : patch.currentCheck,
      patch.error === undefined ? saved.error : patch.error,
      runId,
      projectId,
      workspaceId,
    );
    return metadataRun(projectId, workspaceId, runId);
  });
}
export function appendVerificationResult(
  projectId: string,
  runId: string,
  value: unknown,
): CheckRun {
  const workspaceId = projectAccess(projectId),
    parsed = checkResultSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid check result.",
    );
  const result = parsed.data,
    json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 2 * 1024 * 1024)
    throw new HttpError(
      413,
      "A check result exceeds its 2 MB history limit. Store a bounded diagnostic preview instead.",
    );
  const db = getDatabase();
  return withTransaction(db, () => {
    const saved = metadataRun(projectId, workspaceId, runId);
    const position = db
      .prepare(
        "SELECT COUNT(*) AS n,MAX(ordinal) AS lastOrdinal FROM verification_results WHERE run_id=?",
      )
      .get(runId)!;
    if (
      Number(position.n) !== saved.completed ||
      (saved.completed && Number(position.lastOrdinal) !== saved.completed - 1)
    )
      throw new HttpError(
        500,
        "Saved check progress does not reconcile with its result rows.",
      );
    if (terminal.has(saved.status))
      throw new HttpError(
        409,
        "A finished checks run cannot receive more results.",
      );
    if (saved.completed >= saved.total)
      throw new HttpError(
        409,
        "The checks plan must include this result before it is recorded.",
      );
    if (
      db
        .prepare(
          "SELECT 1 FROM verification_results WHERE run_id=? AND result_id=?",
        )
        .get(runId, result.id)
    )
      throw new HttpError(409, "This check already has a recorded result.");
    const counts = { ...saved.counts };
    counts[result.status]++;
    db.prepare(
      "INSERT INTO verification_results(run_id,ordinal,result_id,result_json) VALUES(?,?,?,?)",
    ).run(runId, saved.completed, result.id, json);
    db.prepare(
      "UPDATE verification_runs SET completed=?,counts_json=? WHERE id=? AND project_id=? AND workspace_id=?",
    ).run(
      saved.completed + 1,
      JSON.stringify(counts),
      runId,
      projectId,
      workspaceId,
    );
    return metadataRun(projectId, workspaceId, runId);
  });
}
export function readCheckSettings(projectId: string): CheckSettings {
  const workspaceId = projectAccess(projectId);
  const row = getDatabase()
    .prepare(
      "SELECT json FROM verification_settings WHERE project_id=? AND workspace_id=?",
    )
    .get(projectId, workspaceId);
  try {
    return checkSettingsSchema.parse(row ? JSON.parse(String(row.json)) : {});
  } catch {
    throw new HttpError(
      500,
      "Saved check settings are invalid or use an unsupported version. They have not been changed.",
    );
  }
}
export function saveCheckSettings(
  projectId: string,
  value: unknown,
): CheckSettings {
  const workspaceId = projectAccess(projectId),
    parsed = checkSettingsSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ??
        "Provide valid versioned check settings.",
    );
  getDatabase()
    .prepare(
      "INSERT INTO verification_settings(project_id,workspace_id,json,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at WHERE workspace_id=excluded.workspace_id",
    )
    .run(
      projectId,
      workspaceId,
      JSON.stringify(parsed.data),
      new Date().toISOString(),
    );
  return readCheckSettings(projectId);
}
export function getVerificationSnapshot(
  projectId: string,
  runId: string,
): unknown {
  const workspaceId = projectAccess(projectId);
  metadataRun(projectId, workspaceId, runId);
  const row = getDatabase()
    .prepare(
      "SELECT snapshot_json FROM verification_runs WHERE id=? AND project_id=? AND workspace_id=?",
    )
    .get(runId, projectId, workspaceId)!;
  try {
    return snapshotSchema.parse(JSON.parse(String(row.snapshot_json))).data;
  } catch {
    throw new HttpError(
      500,
      "The saved checks snapshot is invalid or uses an unsupported version.",
    );
  }
}
export function getVerificationOwnerPid(
  projectId: string,
  runId: string,
): number | null {
  const workspaceId = projectAccess(projectId);
  metadataRun(projectId, workspaceId, runId);
  const row = getDatabase()
    .prepare(
      "SELECT owner_pid FROM verification_runs WHERE id=? AND project_id=? AND workspace_id=?",
    )
    .get(runId, projectId, workspaceId);
  return typeof row?.owner_pid === "number" &&
    Number.isInteger(row.owner_pid) &&
    row.owner_pid > 0
    ? row.owner_pid
    : null;
}
