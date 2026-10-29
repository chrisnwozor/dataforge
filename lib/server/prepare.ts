import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, lstat, realpath, rename, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished, pipeline as streamPipeline } from "node:stream/promises";
import { z } from "zod";
import { executePipeline } from "@/lib/prepare/engine";
import { rowsToCsv, encodeCsvRow } from "@/lib/prepare/csv";
import { analyzePipeline } from "@/lib/prepare/lineage";
import { preparedTypeHints } from "@/lib/prepare/type-hints";
import { pipelineDefinitionSchema, type PrepareRow } from "@/lib/prepare/schema";
import type { PipelineSummary, PrepareReject, PreparedPreview } from "@/lib/prepare/types";
import { profileFile } from "@/lib/profiler";
import { dataDirectory, getDatabase } from "./db";
import { HttpError, projectIdSchema } from "./http";
import { projectUploadDirectory, publishPreparedProfile, readColumnProfiles } from "./projects";
import {
  assertNoActiveLoad, bumpPipelineVersion, createPreparationRun, ensureDefaultPipeline,
  finishPreparationRun, getPreparationRun, listPreparationRuns, preparedPath,
  readPipeline, readPreparationRejects, savePreparationRejects, setPipelineState,
  type PreparationRun, type SavedPipeline,
} from "./prepare-storage";

export interface PreparedDataset { filePath: string; columns: string[]; summary: PipelineSummary; rejects: PrepareReject[]; version: number; qualityRunId: string }
export interface PreparedDatasetOptions { signal?: AbortSignal; onProgress?: (summary: PipelineSummary) => void | Promise<void>; runId?: string; force?: boolean; expectedVersion?: number }
interface PreparationJob { projectId: string; version: number; controller: AbortController; done: Promise<PreparedDataset> }
const globals = globalThis as typeof globalThis & { dataforgePreparationJobs?: Map<string, PreparationJob> };
const jobs = globals.dataforgePreparationJobs ??= new Map();
const processStartedAt = Date.now() - process.uptime() * 1_000;
const jobKey = (projectId: string) => `${dataDirectory()}:${projectId}`;
const emptySummary = (): PipelineSummary => ({ rowsRead: 0, rowsOut: 0, rowsRejected: 0, steps: [], rules: [], warnings: [] });
const messageFor = (error: unknown) => error instanceof Error ? error.message : "The preparation pipeline could not be completed.";
function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("Preparation wait cancelled.", "AbortError")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
const previewCache = new Map<string, { value: PreparedPreview & { lineage: ReturnType<typeof analyzePipeline>["lineage"]; warnings: string[] }; expires: number; bytes: number }>();

async function sourcesFor(projectId: string) { return (await import("./sources")).engineSources(projectId); }
async function writeChunk(stream: WriteStream, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (stream.destroyed) throw stream.errored ?? new Error("The preparation output file closed unexpectedly.");
  if (!stream.write(bytes)) await once(stream, "drain", { signal });
}
function csvText(value: string): string { return /^[\s]*[=+@-]/.test(value) ? `'${value}` : value; }
function rejectCsv(reject: PrepareReject): Uint8Array {
  return encodeCsvRow([reject.stepId, reject.stepName, reject.ruleName, reject.bucket ?? "", reject.rowNumber, JSON.stringify(reject.values)].map((value) => typeof value === "string" ? csvText(value) : value));
}
function sampledReject(reject: PrepareReject): PrepareReject {
  const values: PrepareRow = Object.create(null) as PrepareRow;
  let bytes = 0;
  for (const [name, value] of Object.entries(reject.values)) {
    const next = typeof value === "string" && value.length > 8_192 ? `${value.slice(0, 8_192)}… [full value in rejects CSV]` : value;
    bytes += name.length * 2 + String(next ?? "").length * 2;
    if (bytes > 64 * 1024) { values["[Preview truncated]"] = "Download the rejects CSV for all original values."; break; }
    values[name] = next;
  }
  return { ...reject, values };
}
async function safePreparedFile(projectId: string, filePath: string): Promise<string> {
  let actual: string, root: string;
  try { [actual, root] = await Promise.all([realpath(/* turbopackIgnore: true */ filePath), realpath(/* turbopackIgnore: true */ join(projectUploadDirectory(projectId), "prepared"))]); }
  catch { throw new HttpError(422, "The prepared output is unavailable. Run Prepare again to rebuild it."); }
  const nested = relative(root, actual);
  if (nested === ".." || nested.startsWith(`..${sep}`) || !nested) throw new HttpError(422, "The prepared output is outside its project folder.");
  if (!(await lstat(/* turbopackIgnore: true */ filePath)).isFile() || (await lstat(/* turbopackIgnore: true */ filePath)).isSymbolicLink()) throw new HttpError(422, "The prepared output must be a regular file.");
  return actual;
}
async function preparationDirectory(projectId: string, runId: string, create: boolean): Promise<string> {
  if (!projectIdSchema.safeParse(projectId).success || !projectIdSchema.safeParse(runId).success) throw new HttpError(400, "Invalid preparation identity.");
  let directory = await realpath(/* turbopackIgnore: true */ dataDirectory());
  for (const segment of ["uploads", projectId, "prepared", "runs", runId]) {
    directory = join(/* turbopackIgnore: true */ directory, segment);
    if (create) await mkdir(/* turbopackIgnore: true */ directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(/* turbopackIgnore: true */ directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(422, "Preparation files must remain in regular directories inside the project.");
  }
  return directory;
}

async function performPreparation(saved: SavedPipeline, controller: AbortController, options: PreparedDatasetOptions): Promise<PreparedDataset> {
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const publishState = (patch: Parameters<typeof setPipelineState>[2]) => {
    if (jobs.get(jobKey(saved.projectId))?.controller === controller) setPipelineState(saved.projectId, saved.version, patch);
  };
  signal.throwIfAborted();
  assertNoActiveLoad(saved.projectId, options.runId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== saved.version) throw new HttpError(409, "The pipeline changed after the scripts were generated. Prepare the current version and generate again.");
  const record = createPreparationRun(saved.projectId, saved.version, options.runId);
  let directory: string;
  try { directory = await preparationDirectory(saved.projectId, record.id, true); }
  catch (error) {
    const message = messageFor(error);
    finishPreparationRun(saved.projectId, record.id, "failed", emptySummary(), message, "");
    publishState({ status: "failed", error: message, qualityRunId: record.id });
    throw error;
  }
  const filePath = join(directory, "prepared.csv");
  const temporary = join(directory, "prepared.tmp");
  const rejectsPath = join(directory, "rejects.csv");
  const rejects: PrepareReject[] = [];
  let execution: Awaited<ReturnType<typeof executePipeline>> | undefined;
  let summary = emptySummary();
  let lastProgress = 0;
  let rejectError: unknown;
  const rejectStream = createWriteStream(/* turbopackIgnore: true */ rejectsPath, { flags: "wx", mode: 0o600 });
  const rejectFinished = finished(rejectStream).catch((error: unknown) => { rejectError = error; });
  const publishProgress = async (value: PipelineSummary) => {
    signal.throwIfAborted(); summary = value;
    if (Date.now() - lastProgress < 200) return;
    lastProgress = Date.now();
    publishState({ status: "running", progress: value, qualityRunId: record.id });
    if (options.runId) getDatabase().prepare("UPDATE runs SET prepare_summary = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(value), options.runId, saved.projectId);
    await options.onProgress?.(value);
  };
  try {
    publishState({ status: "running", progress: summary, error: null, qualityRunId: record.id });
    await writeChunk(rejectStream, encodeCsvRow(["step_id", "step", "rule", "bucket", "row_number", "original_values"]), signal);
    execution = await executePipeline(saved.definition, await sourcesFor(saved.projectId), {
      signal, onProgress: publishProgress,
      onReject: async (reject) => {
        if (rejectError) throw rejectError;
        if (rejects.length < 100) rejects.push(sampledReject(reject));
        await writeChunk(rejectStream, rejectCsv(reject), signal);
      },
    });
    summary = execution.summary;
    await streamPipeline(Readable.from(rowsToCsv(execution.columns, execution.rows)), createWriteStream(/* turbopackIgnore: true */ temporary, { flags: "wx", mode: 0o600 }), { signal });
    signal.throwIfAborted();
    rejectStream.end(); await rejectFinished; if (rejectError) throw rejectError;
    if (readPipeline(saved.projectId)?.version !== saved.version) throw new HttpError(409, "A newer pipeline version replaced this preparation. Its output was not published.");
    await rename(/* turbopackIgnore: true */ temporary, filePath);
    // A load executes the already-profiled, pinned pipeline without changing the schema underneath its scripts.
    if (!options.runId) {
      const hints = preparedTypeHints(saved.definition);
      const profile = await profileFile(filePath, "CSV", { signal, allowEmpty: true, columnTypes: hints, onProgress: async () => { signal.throwIfAborted(); await options.onProgress?.(summary); } });
      signal.throwIfAborted(); assertNoActiveLoad(saved.projectId);
      if (!publishPreparedProfile(saved.projectId, saved.version, profile, filePath, hints)) throw new HttpError(409, "A newer pipeline version replaced this profile. Its results were not published.");
    }
    savePreparationRejects(saved.projectId, record.id, rejects);
    finishPreparationRun(saved.projectId, record.id, "succeeded", summary, null, rejectsPath);
    publishState({ status: "succeeded", progress: summary, error: null, qualityRunId: record.id, ...(options.runId ? {} : { filePath, profiled: true }) });
    if (options.runId) getDatabase().prepare("UPDATE runs SET prepare_summary = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(summary), options.runId, saved.projectId);
    await options.onProgress?.(summary);
    return { filePath, columns: execution.columns, summary, rejects, version: saved.version, qualityRunId: record.id };
  } catch (error) {
    summary = execution?.summary ?? summary;
    rejectStream.end(); await rejectFinished;
    await rm(/* turbopackIgnore: true */ temporary, { force: true }).catch(() => {});
    const status = signal.aborted ? "cancelled" : "failed";
    const message = signal.aborted ? "Preparation cancelled." : messageFor(error);
    savePreparationRejects(saved.projectId, record.id, rejects);
    finishPreparationRun(saved.projectId, record.id, status, summary, message, rejectsPath);
    publishState({ status: options.runId && saved.profiledVersion === saved.version ? "succeeded" : status, progress: summary, error: options.runId ? saved.error : message, qualityRunId: record.id });
    if (options.runId) getDatabase().prepare("UPDATE runs SET prepare_summary = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(summary), options.runId, saved.projectId);
    if (error instanceof HttpError) throw error;
    throw new HttpError(signal.aborted ? 499 : 422, message);
  } finally { await execution?.close(); }
}

function startPreparation(saved: SavedPipeline, options: PreparedDatasetOptions): PreparationJob {
  const key = jobKey(saved.projectId), controller = new AbortController();
  const done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => performPreparation(saved, controller, options));
  const job = { projectId: saved.projectId, version: saved.version, controller, done };
  jobs.set(key, job);
  void done.catch(() => {}).finally(() => { if (jobs.get(key) === job) jobs.delete(key); });
  return job;
}

export async function queuePreparedProfile(projectId: string, options: { bumpVersion?: boolean } = {}): Promise<SavedPipeline> {
  let saved = await ensureDefaultPipeline(projectId);
  assertNoActiveLoad(projectId);
  if (options.bumpVersion) saved = bumpPipelineVersion(projectId);
  const previous = jobs.get(jobKey(projectId)); previous?.controller.abort();
  setPipelineState(projectId, saved.version, { status: "queued", progress: null, error: null });
  startPreparation(readPipeline(projectId)!, {});
  previewCache.clear();
  return readPipeline(projectId)!;
}
export async function ensurePreparedDataset(projectId: string, options: PreparedDatasetOptions = {}): Promise<PreparedDataset> {
  options.signal?.throwIfAborted();
  const saved = await ensureDefaultPipeline(projectId);
  if (options.expectedVersion !== undefined && options.expectedVersion !== saved.version) throw new HttpError(409, "The pipeline changed after generation. Generate the current pipeline before loading.");
  const pending = jobs.get(jobKey(projectId));
  if (pending && pending.version === saved.version && !pending.controller.signal.aborted && !options.force && !options.runId) return awaitWithSignal(pending.done, options.signal);
  const path = preparedPath(projectId);
  if (!options.force && !options.runId && path && saved.profiledVersion === saved.version && saved.status === "succeeded" && saved.progress && saved.qualityRunId) {
    return { filePath: await safePreparedFile(projectId, path), columns: readColumnProfiles(projectId).map((column) => column.name), summary: saved.progress, rejects: readPreparationRejects(projectId, saved.qualityRunId), version: saved.version, qualityRunId: saved.qualityRunId };
  }
  assertNoActiveLoad(projectId, options.runId);
  pending?.controller.abort();
  return startPreparation(saved, options).done;
}
export function executePreparedDataset(projectId: string, options: PreparedDatasetOptions = {}): Promise<PreparedDataset> { return ensurePreparedDataset(projectId, { ...options, force: true }); }
export async function requirePreparedProfile(projectId: string, options: { signal?: AbortSignal } = {}): Promise<SavedPipeline | null> {
  let saved = readPipeline(projectId);
  if (saved && (saved.status === "running" || saved.status === "queued")) saved = await preparationStatus(projectId);
  // Legacy profiles remain usable without copying/re-reading their original file.
  if (!saved || saved.profiledVersion === saved.version && saved.status === "succeeded") return saved;
  if (saved.status === "failed" || saved.status === "cancelled") throw new HttpError(409, saved.error ? `Prepare the current pipeline before generating scripts: ${saved.error}` : "Prepare the current pipeline before generating scripts.");
  options.signal?.throwIfAborted();
  await ensurePreparedDataset(projectId, options);
  return readPipeline(projectId);
}
export async function cancelPreparedProfile(projectId: string): Promise<SavedPipeline> {
  const saved = await preparationStatus(projectId);
  if (saved.status !== "queued" && saved.status !== "running") return saved;
  const job = jobs.get(jobKey(projectId));
  if (!job && saved.status === "running") throw new HttpError(409, "Preparation is running in another Node worker. Cancel it in the persistent process that owns this job.");
  job?.controller.abort();
  setPipelineState(projectId, saved.version, { status: "cancelled", error: "Preparation cancelled." });
  return readPipeline(projectId)!;
}
export async function waitForPreparation(projectId: string): Promise<PreparedDataset | undefined> { return jobs.get(jobKey(projectId))?.done; }
/** Recover old worker records lazily, without starting a second Node scheduler. */
export async function preparationStatus(projectId: string): Promise<SavedPipeline> {
  const saved = await ensureDefaultPipeline(projectId);
  if (saved.status !== "queued" && saved.status !== "running" || jobs.has(jobKey(projectId))) return saved;
  const row = saved.qualityRunId ? getDatabase().prepare("SELECT owner_pid, started_at, status FROM pipeline_quality_runs WHERE project_id = ? AND id = ?").get(projectId, saved.qualityRunId) : undefined;
  let interrupted = Date.parse(saved.updatedAt) < processStartedAt;
  if (row && (row.status === "running" || row.status === "queued")) {
    const owner = row.owner_pid === null ? null : Number(row.owner_pid);
    if (owner && owner !== process.pid) {
      try { process.kill(owner, 0); return saved; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return saved; }
      interrupted = true;
    } else if (owner === process.pid) interrupted = Date.parse(String(row.started_at)) < processStartedAt;
    else interrupted = true;
  }
  if (!interrupted) return saved;
  const error = "Preparation was interrupted when its Node process stopped. Run Prepare again.";
  if (row && (row.status === "running" || row.status === "queued") && saved.qualityRunId) {
    const previous = getPreparationRun(projectId, saved.qualityRunId);
    finishPreparationRun(projectId, previous.id, "failed", previous.summary, error, "");
  }
  setPipelineState(projectId, saved.version, { status: "failed", error });
  return readPipeline(projectId)!;
}

export async function previewPipeline(projectId: string, input: unknown, signal?: AbortSignal): Promise<PreparedPreview & { lineage: ReturnType<typeof analyzePipeline>["lineage"]; warnings: string[] }> {
  const saved = await ensureDefaultPipeline(projectId);
  const parsed = z.object({ definition: pipelineDefinitionSchema.optional(), stepIndex: z.number().int().min(-1).max(99).default(saved.definition.steps.length - 1), limit: z.number().int().min(1).max(1_000).default(1_000) }).strict().safeParse(input);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Choose a preview step and up to 1,000 source rows.");
  const definition = parsed.data.definition ?? saved.definition;
  if (parsed.data.stepIndex >= definition.steps.length) throw new HttpError(400, "Choose a step in this pipeline.");
  const sources = await sourcesFor(projectId);
  const validation = analyzePipeline(definition, sources, parsed.data.stepIndex);
  if (!validation.valid) throw new HttpError(400, validation.errors.map((error) => error.message).join(" "));
  const key = JSON.stringify([dataDirectory(), projectId, saved.version, definition, parsed.data.stepIndex, parsed.data.limit]);
  const cached = previewCache.get(key);
  if (cached && cached.expires > Date.now()) { signal?.throwIfAborted(); return cached.value; }
  const collect = async (stopAfterStep: number) => {
    let execution: Awaited<ReturnType<typeof executePipeline>> | undefined;
    const rows: PrepareRow[] = []; let bytes = 0;
    try {
      execution = await executePipeline(definition, sources, { signal, sourceLimit: parsed.data.limit, stopAfterStep });
      for await (const row of execution.rows) {
        bytes += JSON.stringify(row).length * 2;
        if (rows.length < 1_000 && bytes <= 8 * 1024 * 1024) rows.push(row);
        if (bytes > 32 * 1024 * 1024) throw new HttpError(413, "This preview expands to too much data. Select fewer columns or preview an earlier step.");
      }
      return { rows, columns: execution.columns, summary: execution.summary };
    } catch (error) {
      if (signal?.aborted || error instanceof HttpError) throw error;
      throw new HttpError(422, messageFor(error));
    } finally { await execution?.close(); }
  };
  const before = await collect(Math.max(-1, parsed.data.stepIndex - 1));
  const after = parsed.data.stepIndex === -1 ? before : await collect(parsed.data.stepIndex);
  const changed = new Set<string>([...before.columns.filter((name) => !after.columns.includes(name)), ...after.columns.filter((name) => !before.columns.includes(name))]);
  const selected = definition.steps[parsed.data.stepIndex];
  const keepsRowAlignment = selected && !["filter", "dedupe", "sort", "conditionalSplit", "quality", "union", "unpivot", "join"].includes(selected.type);
  if (keepsRowAlignment) for (const name of after.columns) if (after.rows.some((row, index) => row[name] !== before.rows[index]?.[name])) changed.add(name);
  const value = { before: before.rows, after: after.rows, beforeColumns: before.columns, afterColumns: after.columns, changedColumns: [...changed], summary: after.summary, version: saved.version, sampled: true, lineage: validation.lineage, warnings: after.summary.warnings };
  const bytes = JSON.stringify(value).length * 2;
  if (bytes <= 16 * 1024 * 1024) {
    previewCache.set(key, { value, bytes, expires: Date.now() + 60_000 });
    let total = [...previewCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (previewCache.size > 12 || total > 32 * 1024 * 1024) { const first = previewCache.keys().next().value!; total -= previewCache.get(first)!.bytes; previewCache.delete(first); }
  }
  return value;
}

export function readQuality(projectId: string, requestedRunId?: string): { summary: PipelineSummary | null; rejects: PrepareReject[]; downloadUrl: string | null; run: PreparationRun | null; runs: PreparationRun[] } {
  const runs = listPreparationRuns(projectId);
  let run = requestedRunId ? runs.find((candidate) => candidate.id === requestedRunId || candidate.warehouseRunId === requestedRunId) : runs[0];
  if (requestedRunId && !run) {
    if (!projectIdSchema.safeParse(requestedRunId).success) throw new HttpError(400, "Invalid preparation run ID.");
    const prepared = getDatabase().prepare("SELECT id FROM pipeline_quality_runs WHERE warehouse_run_id = ? AND project_id = ? ORDER BY started_at DESC LIMIT 1").get(requestedRunId, projectId);
    if (prepared) run = getPreparationRun(projectId, String(prepared.id));
    const owned = getDatabase().prepare("SELECT id FROM runs WHERE id = ? AND project_id = ?").get(requestedRunId, projectId);
    if (!owned) {
      try { run = getPreparationRun(projectId, requestedRunId); } catch { throw new HttpError(404, "Quality results not found in this project."); }
    }
  }
  return { summary: run?.summary ?? null, rejects: run ? readPreparationRejects(projectId, run.id) : [], downloadUrl: run ? `/api/projects/${encodeURIComponent(projectId)}/pipeline/runs/${encodeURIComponent(run.id)}/rejects` : null, run: run ?? null, runs };
}
export async function preparationRejectsResponse(projectId: string, runId: string): Promise<Response> {
  const run = getPreparationRun(projectId, runId);
  const path = join(await preparationDirectory(projectId, run.id, false), "rejects.csv");
  const actual = await safePreparedFile(projectId, path).catch(() => { throw new HttpError(404, "The rejected-row export is unavailable."); });
  return new Response(Readable.toWeb(createReadStream(/* turbopackIgnore: true */ actual)) as ReadableStream<Uint8Array>, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="prepare-${run.id}-rejects.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
