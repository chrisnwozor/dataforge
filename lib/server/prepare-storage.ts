import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { defaultPipeline, pipelineDefinitionSchema, type PipelineDefinition } from "@/lib/prepare/schema";
import type { PipelineSummary, PrepareReject } from "@/lib/prepare/types";
import { sourceOptionsSchema, uniqueSourceHeaders } from "@/lib/prepare/readers";
import { dataDirectory, getDatabase, withTransaction } from "./db";
import { boundedBody, HttpError, projectIdSchema } from "./http";
import { findProject, readColumnProfiles } from "./projects";

export const pipelineStatusSchema = z.enum(["idle", "queued", "running", "succeeded", "failed", "cancelled"]);
const count = z.number().int().nonnegative();
const ruleSummarySchema = z.object({ id: z.string(), name: z.string(), severity: z.enum(["reject", "warn", "fail"]), checked: count, failed: count, ratePct: z.number().min(0).max(100) });
export const pipelineSummarySchema: z.ZodType<PipelineSummary> = z.object({
  rowsRead: count, rowsOut: count, rowsRejected: count,
  steps: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), rowsIn: count, rowsOut: count, rowsRejected: count, removed: count, ruleCounts: z.array(ruleSummarySchema) })),
  rules: z.array(ruleSummarySchema), warnings: z.array(z.string()),
});
export interface SavedPipeline {
  projectId: string; version: number; definition: PipelineDefinition; updatedAt: string;
  status: z.infer<typeof pipelineStatusSchema>; progress: PipelineSummary | null; error: string | null;
  profiledVersion: number | null; qualityRunId: string | null;
}
export interface PreparationRun {
  id: string; projectId: string; version: number; warehouseRunId: string | null;
  status: z.infer<typeof pipelineStatusSchema>; summary: PipelineSummary | null; startedAt: string;
  finishedAt: string | null; error: string | null; rejectedCount: number;
}
const bootstraps = new Map<string, Promise<SavedPipeline>>();
const identity = (value: string) => { const result = projectIdSchema.safeParse(value); if (!result.success) throw new HttpError(400, "Invalid project or preparation run ID."); return result.data; };
const nowAfter = (value: string) => new Date(Math.max(Date.now(), Date.parse(value) + 1)).toISOString();
async function legacyDirectories(projectId: string, sourceId: string): Promise<{ project: string; source: string }> {
  let directory = await realpath(/* turbopackIgnore: true */ dataDirectory());
  let project = "";
  for (const segment of ["uploads", identity(projectId), "sources", identity(sourceId)]) {
    directory = join(/* turbopackIgnore: true */ directory, segment);
    if (segment === "sources" || segment === sourceId) await mkdir(/* turbopackIgnore: true */ directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(/* turbopackIgnore: true */ directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(422, "Source files must remain in regular directories inside their project.");
    if (segment === projectId) project = directory;
  }
  return { project, source: directory };
}

export function hasStoredPipeline(projectId: string): boolean { return !!getDatabase().prepare("SELECT 1 FROM project_pipelines WHERE project_id = ?").get(projectId); }

export function readPipeline(projectId: string): SavedPipeline | null {
  const row = getDatabase().prepare("SELECT project_id AS projectId, version, definition, updated_at AS updatedAt, status, progress, error, profiled_version AS profiledVersion, quality_run_id AS qualityRunId FROM project_pipelines WHERE project_id = ?").get(identity(projectId));
  if (!row) return null;
  try {
    return { projectId: identity(String(row.projectId)), version: z.number().int().positive().parse(row.version), definition: pipelineDefinitionSchema.parse(JSON.parse(String(row.definition))),
      updatedAt: z.string().datetime().parse(row.updatedAt), status: pipelineStatusSchema.parse(row.status), progress: row.progress === null ? null : pipelineSummarySchema.parse(JSON.parse(String(row.progress))),
      error: row.error === null ? null : String(row.error), profiledVersion: row.profiledVersion === null ? null : z.number().int().positive().parse(row.profiledVersion), qualityRunId: row.qualityRunId === null ? null : identity(String(row.qualityRunId)) };
  } catch { throw new HttpError(500, "The saved preparation pipeline is invalid or uses an unsupported version. Its data has not been changed."); }
}

/** Existing projects retain their saved profile until a real pipeline edit occurs. */
export async function ensureDefaultPipeline(projectId: string): Promise<SavedPipeline> {
  const current = readPipeline(projectId); if (current) return current;
  const key = `${dataDirectory()}:${projectId}`;
  const pending = bootstraps.get(key); if (pending) return pending;
  const operation = (async () => {
    const project = findProject(projectId); if (!project) throw new HttpError(404, "Project not found.");
    const sources = getDatabase().prepare("SELECT id FROM project_sources WHERE project_id = ? ORDER BY created_at, id").all(projectId);
    let sourceId = sources[0]?.id ? String(sources[0].id) : randomUUID();
    let copiedDirectory: string | null = null;
    if (!sources.length) {
      if (!project.sourceFile || basename(project.sourceFile) !== project.sourceFile || /[\\/:\u0000]/.test(project.sourceFile) || [".", ".."].includes(project.sourceFile)) throw new HttpError(422, "The original source path is invalid. Re-import the project.");
      const checked = await legacyDirectories(projectId, sourceId);
      const directory = checked.project;
      let retained: string;
      try {
        const sourcePath = join(/* turbopackIgnore: true */ directory, project.sourceFile);
        const [actual, actualDirectory] = await Promise.all([realpath(/* turbopackIgnore: true */ sourcePath), realpath(/* turbopackIgnore: true */ directory)]);
        if (dirname(actual) !== actualDirectory) throw new Error("Source is outside its project.");
        const information = await lstat(/* turbopackIgnore: true */ sourcePath);
        if (!information.isFile() || information.isSymbolicLink() || information.size > 50 * 1024 * 1024) throw new Error("Invalid source file.");
        retained = actual;
      } catch { throw new HttpError(422, "The original source is unavailable. Restore it in data/uploads or replace the project source."); }
      copiedDirectory = checked.source;
      const filePath = join(/* turbopackIgnore: true */ copiedDirectory, project.sourceFile);
      await copyFile(/* turbopackIgnore: true */ retained, /* turbopackIgnore: true */ filePath);
      const profiles = readColumnProfiles(projectId), names = uniqueSourceHeaders(profiles.map((column) => column.name));
      const columns = profiles.map((column, index) => ({ name: names[index], type: column.overrideType ?? column.inferredType }));
      try {
        withTransaction(getDatabase(), () => {
          const existing = getDatabase().prepare("SELECT id FROM project_sources WHERE project_id = ? ORDER BY created_at, id LIMIT 1").get(projectId);
          if (existing) { sourceId = String(existing.id); return; }
          getDatabase().prepare("INSERT INTO project_sources (id, project_id, name, kind, file_path, options, row_count, columns, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(sourceId, projectId, project.sourceFile, project.sourceType.toLowerCase(), filePath, JSON.stringify(sourceOptionsSchema.parse({})), project.rowCount, JSON.stringify(columns), project.createdAt);
        });
      } catch (error) { await rm(/* turbopackIgnore: true */ copiedDirectory, { recursive: true, force: true }); throw error; }
    }
    const updatedAt = new Date().toISOString();
    getDatabase().prepare("INSERT INTO project_pipelines (project_id, version, definition, updated_at, status, profiled_version) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING")
      .run(projectId, 1, JSON.stringify(defaultPipeline(sourceId)), updatedAt, "succeeded", 1);
    return readPipeline(projectId)!;
  })();
  bootstraps.set(key, operation);
  try { return await operation; } finally { bootstraps.delete(key); }
}

export async function savePipeline(projectId: string, input: unknown): Promise<SavedPipeline> {
  const parsed = z.object({ definition: pipelineDefinitionSchema, version: z.number().int().positive() }).strict().safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Provide a valid pipeline definition and saved version.");
  await ensureDefaultPipeline(projectId);
  assertNoActiveLoad(projectId);
  return withTransaction(getDatabase(), () => {
    const saved = readPipeline(projectId)!;
    if (saved.version !== parsed.data.version) throw new HttpError(409, "This pipeline changed in another tab. Reload before saving your edits.");
    const sources = new Set(getDatabase().prepare("SELECT id FROM project_sources WHERE project_id = ?").all(projectId).map((row) => String(row.id)));
    const references = [parsed.data.definition.mainSourceId, ...parsed.data.definition.steps.flatMap((step) => "sourceId" in step ? [step.sourceId] : [])];
    if (references.some((id) => !sources.has(id))) throw new HttpError(400, "Choose sources saved in this project. A referenced source may have been removed.");
    getDatabase().prepare("UPDATE project_pipelines SET definition = ?, version = version + 1, updated_at = ?, status = 'queued', error = NULL, progress = NULL WHERE project_id = ? AND version = ?")
      .run(JSON.stringify(parsed.data.definition), nowAfter(saved.updatedAt), projectId, saved.version);
    return readPipeline(projectId)!;
  });
}

export function bumpPipelineVersion(projectId: string): SavedPipeline {
  assertNoActiveLoad(projectId);
  const saved = readPipeline(projectId); if (!saved) throw new HttpError(404, "Pipeline not found.");
  getDatabase().prepare("UPDATE project_pipelines SET version = version + 1, updated_at = ?, status = 'queued', error = NULL, progress = NULL WHERE project_id = ?").run(nowAfter(saved.updatedAt), projectId);
  return readPipeline(projectId)!;
}
export function assertNoActiveLoad(projectId: string, ownRunId?: string): void {
  const active = getDatabase().prepare("SELECT id FROM runs WHERE project_id = ? AND status IN ('queued', 'running') LIMIT 1").get(projectId);
  if (active && String(active.id) !== ownRunId) throw new HttpError(409, "Wait for or cancel the active load before changing sources or preparation settings.");
}
export function setPipelineState(projectId: string, version: number, patch: { status?: SavedPipeline["status"]; progress?: PipelineSummary | null; error?: string | null; qualityRunId?: string | null; filePath?: string; profiled?: boolean }): void {
  const saved = readPipeline(projectId); if (!saved || saved.version !== version) return;
  const progress = patch.progress === undefined ? saved.progress : patch.progress;
  getDatabase().prepare("UPDATE project_pipelines SET status = ?, progress = ?, error = ?, quality_run_id = ?, prepared_path = COALESCE(?, prepared_path), profiled_version = ? WHERE project_id = ? AND version = ?")
    .run(patch.status ?? saved.status, progress === null ? null : JSON.stringify(progress), patch.error === undefined ? saved.error : patch.error, patch.qualityRunId === undefined ? saved.qualityRunId : patch.qualityRunId, patch.filePath ?? null, patch.profiled ? version : saved.profiledVersion, projectId, version);
}
export function preparedPath(projectId: string): string | null { const row = getDatabase().prepare("SELECT prepared_path FROM project_pipelines WHERE project_id = ?").get(projectId); return row?.prepared_path ? String(row.prepared_path) : null; }

export function createPreparationRun(projectId: string, version: number, warehouseRunId?: string): PreparationRun {
  const id = randomUUID();
  getDatabase().prepare("INSERT INTO pipeline_quality_runs (id, project_id, pipeline_version, warehouse_run_id, status, started_at, owner_pid) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, projectId, version, warehouseRunId ?? null, "running", new Date().toISOString(), process.pid);
  return getPreparationRun(projectId, id);
}
function readRun(row: Record<string, unknown>): PreparationRun {
  const summary = row.summary === null ? null : pipelineSummarySchema.parse(JSON.parse(String(row.summary)));
  return { id: identity(String(row.id)), projectId: identity(String(row.projectId)), version: z.number().int().positive().parse(row.version), warehouseRunId: row.warehouseRunId === null ? null : identity(String(row.warehouseRunId)),
    status: pipelineStatusSchema.parse(row.status), summary, startedAt: z.string().datetime().parse(row.startedAt), finishedAt: row.finishedAt === null ? null : z.string().datetime().parse(row.finishedAt), error: row.error === null ? null : String(row.error), rejectedCount: summary?.rowsRejected ?? Number(row.rejectedCount ?? 0) };
}
const runSelect = "SELECT q.id, q.project_id AS projectId, q.pipeline_version AS version, q.warehouse_run_id AS warehouseRunId, q.status, q.summary, q.started_at AS startedAt, q.finished_at AS finishedAt, q.error, (SELECT COUNT(*) FROM prepare_rejected_rows r WHERE r.quality_run_id = q.id) AS rejectedCount FROM pipeline_quality_runs q";
export function listPreparationRuns(projectId: string): PreparationRun[] { return getDatabase().prepare(`${runSelect} WHERE q.project_id = ? ORDER BY q.started_at DESC, q.id DESC LIMIT 100`).all(projectId).map(readRun); }
export function getPreparationRun(projectId: string, runId: string): PreparationRun {
  const row = getDatabase().prepare(`${runSelect} WHERE q.project_id = ? AND q.id = ?`).get(identity(projectId), identity(runId));
  if (!row) throw new HttpError(404, "Preparation run not found in this project."); return readRun(row);
}
export function finishPreparationRun(projectId: string, runId: string, status: SavedPipeline["status"], summary: PipelineSummary | null, error: string | null, rejectsPath: string): void {
  getPreparationRun(projectId, runId);
  getDatabase().prepare("UPDATE pipeline_quality_runs SET status = ?, summary = ?, finished_at = ?, error = ?, rejects_path = ? WHERE project_id = ? AND id = ?")
    .run(status, summary === null ? null : JSON.stringify(pipelineSummarySchema.parse(summary)), new Date().toISOString(), error, rejectsPath, projectId, runId);
}
export function savePreparationRejects(projectId: string, runId: string, rejects: readonly PrepareReject[]): void {
  getPreparationRun(projectId, runId);
  withTransaction(getDatabase(), () => {
    getDatabase().prepare("DELETE FROM prepare_rejected_rows WHERE quality_run_id = ?").run(runId);
    const insert = getDatabase().prepare("INSERT INTO prepare_rejected_rows (quality_run_id, ordinal, step_id, step_name, rule_name, bucket, source_row_number, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    rejects.slice(0, 100).forEach((reject, ordinal) => insert.run(runId, ordinal, reject.stepId, reject.stepName, reject.ruleName, reject.bucket ?? null, reject.rowNumber, JSON.stringify(reject.values)));
  });
}
export function readPreparationRejects(projectId: string, runId: string): PrepareReject[] {
  getPreparationRun(projectId, runId);
  return getDatabase().prepare("SELECT step_id AS stepId, step_name AS stepName, rule_name AS ruleName, bucket, source_row_number AS rowNumber, raw_json AS rawJson FROM prepare_rejected_rows WHERE quality_run_id = ? ORDER BY ordinal LIMIT 100").all(runId)
    .map((row) => ({ stepId: String(row.stepId), stepName: String(row.stepName), ruleName: String(row.ruleName), ...(row.bucket ? { bucket: String(row.bucket) } : {}), rowNumber: Number(row.rowNumber), values: JSON.parse(String(row.rawJson)) }));
}
export async function readPipelineBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send pipeline settings as JSON.");
  try { return await new Response(await boundedBody(request, 2 * 1024 * 1024)).json(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "The pipeline request is not valid JSON."); }
}
