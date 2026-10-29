import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { analyzeSource, MAX_SOURCE_BYTES, normalizeSourceRow, readSourceRows, sourceKindSchema, sourceOptionsSchema, workbookSheetNames, type SourceAnalysis, type SourceColumn, type SourceKind, type SourceOptions } from "@/lib/prepare/readers";
import type { EngineSource, PrepareRow } from "@/lib/prepare/types";
import type { PrepareStep } from "@/lib/prepare/schema";
import { dataDirectory, getDatabase, withTransaction } from "./db";
import { boundedBody, HttpError, projectIdSchema } from "./http";
import { findProject } from "./projects";
import { findActiveRun } from "./runs";
import { bumpPipelineVersion } from "./prepare-storage";

const identity = z.string().uuid();
const sourceName = z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const columnSchema = z.object({ name: z.string().min(1).max(256), type: z.enum(["text", "integer", "decimal", "date", "boolean"]) }).strict();
export interface StoredSource {
  id: string; projectId: string; name: string; kind: SourceKind; filePath: string;
  options: SourceOptions; rowCount: number; columns: SourceColumn[]; createdAt: string;
}
export type PublicSource = Omit<StoredSource, "filePath">;
export interface AffectedSourceStep { id: string; name: string; missingColumns: string[] }
const sourceSelect = "SELECT id, project_id AS projectId, name, kind, file_path AS filePath, options, row_count AS rowCount, columns, created_at AS createdAt FROM project_sources";
const checkedId = (value: string) => { if (!identity.safeParse(value).success) throw new HttpError(400, "Invalid source or project ID."); return value; };
function sourceRow(row: Record<string, unknown>): StoredSource {
  try {
    return { id: identity.parse(row.id), projectId: identity.parse(row.projectId), name: sourceName.parse(row.name), kind: sourceKindSchema.parse(row.kind), filePath: z.string().min(1).parse(row.filePath), options: sourceOptionsSchema.parse(JSON.parse(String(row.options))), rowCount: z.number().int().nonnegative().parse(row.rowCount), columns: z.array(columnSchema).max(10_000).parse(JSON.parse(String(row.columns))), createdAt: z.string().datetime().parse(row.createdAt) };
  } catch { throw new HttpError(500, "A saved source is invalid or uses unsupported options. Its file has not been changed."); }
}
export function publicSource(source: StoredSource): PublicSource {
  return { id: source.id, projectId: source.projectId, name: source.name, kind: source.kind, options: source.options, rowCount: source.rowCount, columns: source.columns, createdAt: source.createdAt };
}
async function ensureProjectSources(projectId: string): Promise<void> {
  if (!projectIdSchema.safeParse(projectId).success) throw new HttpError(400, "Invalid project ID.");
  if (!findProject(projectId)) throw new HttpError(404, "Project not found.");
  await (await import("./prepare-storage")).ensureDefaultPipeline(projectId);
}
export function listStoredSources(projectId: string): StoredSource[] {
  return getDatabase().prepare(`${sourceSelect} WHERE project_id = ? ORDER BY created_at, id`).all(checkedId(projectId)).map(sourceRow);
}
export async function listSources(projectId: string): Promise<StoredSource[]> { await ensureProjectSources(projectId); return listStoredSources(projectId); }
export async function getSource(projectId: string, sourceId: string): Promise<StoredSource> {
  await ensureProjectSources(projectId);
  const row = getDatabase().prepare(`${sourceSelect} WHERE project_id = ? AND id = ?`).get(projectId, checkedId(sourceId));
  if (!row) throw new HttpError(404, "Source not found in this project.");
  return sourceRow(row);
}
function mutableProject(projectId: string): void {
  if (findActiveRun(projectId)) throw new HttpError(409, "Wait for the active load to finish or cancel it before changing sources.");
}

/** Runtime file paths are reconstructed beneath a checked project folder, never accepted from clients. */
async function sourceDirectory(projectId: string, folderId: string, create = false): Promise<string> {
  checkedId(projectId); checkedId(folderId);
  const base = dataDirectory();
  if (create) await mkdir(/* turbopackIgnore: true */ base, { recursive: true });
  let current = await realpath(/* turbopackIgnore: true */ base);
  for (const segment of ["uploads", projectId, "sources", folderId]) {
    current = join(/* turbopackIgnore: true */ current, segment);
    if (create) await mkdir(/* turbopackIgnore: true */ current, { recursive: false }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(/* turbopackIgnore: true */ current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(422, "Source files must stay in regular project directories; symbolic links are not supported.");
  }
  return current;
}
export async function safeSourceFile(source: StoredSource): Promise<string> {
  const folderId = basename(dirname(source.filePath));
  let directory: string;
  try { directory = await sourceDirectory(source.projectId, folderId); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(422, "The source file is unavailable. Replace it from Sources."); }
  const filename = basename(source.filePath);
  if (!filename || /[\\/:\u0000-\u001f\u007f]/.test(filename) || [".", ".."].includes(filename)) throw new HttpError(422, "The saved source file path is invalid.");
  const path = join(/* turbopackIgnore: true */ directory, filename);
  try {
    const info = await lstat(/* turbopackIgnore: true */ path);
    const actual = await realpath(/* turbopackIgnore: true */ path);
    if (info.isSymbolicLink() || !info.isFile() || dirname(actual) !== directory || actual !== source.filePath || info.size > MAX_SOURCE_BYTES) throw new Error("Invalid retained source path.");
    return path;
  } catch { throw new HttpError(422, "The source file is missing, too large, or outside its project. Replace it from Sources."); }
}
export async function engineSources(projectId: string): Promise<EngineSource[]> {
  const sources = await listSources(projectId);
  return sources.map((source) => ({ id: source.id, columns: source.columns.map(({ name }) => name), async *open(request = {}) {
    const filePath = await safeSourceFile(source);
    for await (const row of readSourceRows({ ...source, filePath }, { ...request, expectedColumns: source.columns.map(({ name }) => name) })) yield normalizeSourceRow(row, source.columns);
  } }));
}
export async function previewSource(projectId: string, sourceId: string, limit = 20, signal?: AbortSignal): Promise<{ columns: SourceColumn[]; rows: PrepareRow[]; warnings: string[] }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new HttpError(400, "Source previews support between one and 1,000 rows.");
  const source = await getSource(projectId, sourceId); const rows: PrepareRow[] = [], warnings = new Set<string>();
  for await (const row of readSourceRows({ ...source, filePath: await safeSourceFile(source) }, { limit, signal, expectedColumns: source.columns.map(({ name }) => name), onWarning: (warning) => { if (warnings.size < 20) warnings.add(warning); } })) rows.push(normalizeSourceRow(row, source.columns));
  return { columns: source.columns, rows, warnings: [...warnings] };
}

function uploadedKind(file: File): SourceKind {
  const extension = extname(file.name).toLowerCase();
  const kind = extension === ".csv" ? "csv" : extension === ".xlsx" ? "xlsx" : extension === ".json" ? "json" : null;
  if (!kind) throw new HttpError(415, "Choose a CSV, XLSX, or JSON source file.");
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new HttpError(413, "Choose a non-empty source file no larger than 50 MB.");
  const mime = file.type.toLowerCase().split(";")[0];
  const allowed = kind === "xlsx" ? ["", "application/octet-stream", "application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"] : kind === "json" ? ["", "application/octet-stream", "application/json", "text/json", "text/plain"] : ["", "application/octet-stream", "text/csv", "application/csv", "text/plain", "text/tab-separated-values", "application/vnd.ms-excel"];
  if (!allowed.includes(mime)) throw new HttpError(415, "The source MIME type does not match its CSV, XLSX, or JSON extension.");
  return kind;
}
function sourceFilename(value: string, kind: SourceKind): string {
  const stem = basename(value, extname(value)).normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[.]+|[.]+$/g, "").slice(0, 100) || "source";
  return `${stem}.${kind}`;
}
export async function readSourceForm(request: Request): Promise<FormData> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Upload the source as multipart form data.");
  try { return await new Response(await boundedBody(request, MAX_SOURCE_BYTES + 128 * 1024), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "The source upload could not be read. Select the file again."); }
}
function formJson(form: FormData, key: string, fallback: unknown): unknown {
  const text = form.get(key); if (text === null || text === "") return fallback;
  if (typeof text !== "string") throw new HttpError(400, `Send ${key} as JSON text.`);
  try { return JSON.parse(text); } catch { throw new HttpError(400, `The ${key} value is not valid JSON.`); }
}
async function writeUploadedSource(projectId: string, file: File): Promise<{ kind: SourceKind; filePath: string; directory: string }> {
  const kind = uploadedKind(file); const folder = randomUUID(); const directory = await sourceDirectory(projectId, folder, true);
  const filePath = join(/* turbopackIgnore: true */ directory, sourceFilename(file.name, kind));
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (kind === "xlsx" && !(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) throw new HttpError(415, "The selected file is not an XLSX workbook.");
    if (kind !== "xlsx" && (bytes.includes(0) || bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) throw new HttpError(415, "CSV and JSON sources must use UTF-8 text encoding.");
    await writeFile(/* turbopackIgnore: true */ filePath, bytes, { flag: "wx", mode: 0o600 });
    return { kind, filePath, directory };
  } catch (error) { await rm(/* turbopackIgnore: true */ directory, { recursive: true, force: true }); throw error; }
}
async function removeUnreferencedFile(source: StoredSource): Promise<void> {
  if (getDatabase().prepare("SELECT 1 FROM project_sources WHERE project_id = ? AND file_path = ? LIMIT 1").get(source.projectId, source.filePath)) return;
  const path = await safeSourceFile(source).catch(() => null); if (path) await rm(/* turbopackIgnore: true */ dirname(path), { recursive: true, force: true });
}
async function sourceChanged(projectId: string): Promise<void> {
  try { await (await import("./prepare")).queuePreparedProfile(projectId); }
  catch (error) { if (!(error instanceof HttpError && error.status === 409 && findActiveRun(projectId))) throw error; }
}
export async function inspectSourceUpload(projectId: string, request: Request): Promise<{ kind: SourceKind; sheets: string[] }> {
  await ensureProjectSources(projectId);
  const form = await readSourceForm(request), file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a source file to inspect.");
  const saved = await writeUploadedSource(projectId, file);
  try { return { kind: saved.kind, sheets: saved.kind === "xlsx" ? await workbookSheetNames(saved.filePath) : [] }; }
  finally { await rm(/* turbopackIgnore: true */ saved.directory, { recursive: true, force: true }); }
}
export async function uploadSources(projectId: string, request: Request): Promise<{ sources: PublicSource[]; warnings: string[] }> {
  await ensureProjectSources(projectId); mutableProject(projectId);
  const form = await readSourceForm(request), file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Choose a CSV, XLSX, or JSON source file.");
  const options = sourceOptionsSchema.safeParse(formJson(form, "options", {}));
  if (!options.success) throw new HttpError(400, options.error.issues[0]?.message ?? "Choose valid source options.");
  const name = sourceName.safeParse(form.get("name") || file.name);
  if (!name.success) throw new HttpError(400, "Enter a source name with 1–120 characters.");
  const saved = await writeUploadedSource(projectId, file); let inserted = false;
  try {
    let sheets = [""];
    if (saved.kind === "xlsx") {
      const selected = z.array(z.string().min(1).max(100)).min(1).max(25).safeParse(formJson(form, "sheets", [options.data.sheetName ?? (await workbookSheetNames(saved.filePath))[0]]));
      if (!selected.success) throw new HttpError(400, "Choose between one and 25 worksheets per upload.");
      sheets = [...new Set(selected.data)];
    }
    const analyzed: { source: StoredSource; analysis: SourceAnalysis }[] = [];
    for (const sheetName of sheets) {
      request.signal.throwIfAborted();
      const sourceOptions = sourceOptionsSchema.parse({ ...options.data, ...(sheetName ? { sheetName } : {}) });
      const analysis = await analyzeSource({ ...saved, options: sourceOptions }, { signal: request.signal });
      const source: StoredSource = { id: randomUUID(), projectId, name: sheets.length > 1 ? `${name.data.slice(0, 90)} · ${sheetName}`.slice(0, 120) : name.data, kind: saved.kind, filePath: saved.filePath, options: sourceOptions, columns: analysis.columns, rowCount: analysis.rowCount, createdAt: new Date().toISOString() };
      analyzed.push({ source, analysis });
    }
    mutableProject(projectId);
    withTransaction(getDatabase(), () => {
      mutableProject(projectId);
      const statement = getDatabase().prepare("INSERT INTO project_sources (id, project_id, name, kind, file_path, options, row_count, columns, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const { source } of analyzed) statement.run(source.id, projectId, source.name, source.kind, source.filePath, JSON.stringify(source.options), source.rowCount, JSON.stringify(source.columns), source.createdAt);
      bumpPipelineVersion(projectId);
    }); inserted = true;
    await sourceChanged(projectId);
    return { sources: analyzed.map(({ source }) => publicSource(source)), warnings: [...new Set(analyzed.flatMap(({ analysis }) => analysis.warnings))] };
  } catch (error) { if (!inserted) await rm(/* turbopackIgnore: true */ saved.directory, { recursive: true, force: true }); if (error instanceof HttpError || request.signal.aborted) throw error; throw new HttpError(422, error instanceof Error ? error.message : "The source could not be parsed."); }
}

function stepColumns(step: PrepareStep): string[] {
  const names: string[] = [];
  const visit = (value: unknown, key: string) => {
    if (typeof value === "string" && ["column", "name", "otherColumn", "valueColumn", "left", "right", "source"].includes(key)) names.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => typeof entry === "string" && key === "columns" ? names.push(entry) : visit(entry, key));
    else if (value && typeof value === "object") Object.entries(value).forEach(([nested, entry]) => visit(entry, nested));
  };
  visit(step, ""); return names;
}
async function affectedSteps(projectId: string, source: StoredSource, columns: SourceColumn[]): Promise<AffectedSourceStep[]> {
  const pipeline = (await import("./prepare-storage")).readPipeline(projectId);
  if (!pipeline) return [];
  const available = new Set(columns.map(({ name }) => name));
  const missing = source.columns.map(({ name }) => name).filter((name) => !available.has(name));
  if (!missing.length) return [];
  return pipeline.definition.steps.flatMap((step) => {
    const usesSource = pipeline.definition.mainSourceId === source.id || "sourceId" in step && step.sourceId === source.id;
    const missingColumns = usesSource ? missing.filter((name) => stepColumns(step).includes(name) || step.type === "derive" && step.expression.includes(`[${name}]`)) : [];
    return missingColumns.length ? [{ id: step.id, name: step.name || step.type, missingColumns }] : [];
  });
}
export async function updateSource(projectId: string, sourceId: string, request: Request): Promise<{ source: PublicSource; affectedSteps: AffectedSourceStep[]; warnings: string[] }> {
  const prior = await getSource(projectId, sourceId); mutableProject(projectId);
  let uploaded: Awaited<ReturnType<typeof writeUploadedSource>> | undefined;
  let name = prior.name, options = prior.options;
  try {
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await readSourceForm(request), file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Choose the replacement source file.");
      uploaded = await writeUploadedSource(projectId, file);
      options = sourceOptionsSchema.parse(formJson(form, "options", prior.options));
      name = sourceName.parse(form.get("name") || prior.name);
    } else {
      const input = z.object({ name: sourceName.optional(), options: sourceOptionsSchema.optional() }).strict().refine((value) => value.name !== undefined || value.options !== undefined).safeParse(await readSourceJson(request));
      if (!input.success) throw new HttpError(400, "Provide a source name or valid source options.");
      name = input.data.name ?? name; options = input.data.options ?? options;
    }
    const changedOptions = JSON.stringify(options) !== JSON.stringify(prior.options);
    const analysis = uploaded || changedOptions ? await analyzeSource({ filePath: uploaded?.filePath ?? await safeSourceFile(prior), kind: uploaded?.kind ?? prior.kind, options }, { signal: request.signal }) : null;
    const next = { ...prior, name, options, ...(uploaded ? { filePath: uploaded.filePath, kind: uploaded.kind } : {}), ...(analysis ? { columns: analysis.columns, rowCount: analysis.rowCount } : {}) };
    const affected = await affectedSteps(projectId, prior, next.columns);
    mutableProject(projectId);
    withTransaction(getDatabase(), () => {
      mutableProject(projectId);
      getDatabase().prepare("UPDATE project_sources SET name = ?, kind = ?, file_path = ?, options = ?, row_count = ?, columns = ? WHERE project_id = ? AND id = ?").run(next.name, next.kind, next.filePath, JSON.stringify(next.options), next.rowCount, JSON.stringify(next.columns), projectId, sourceId);
      bumpPipelineVersion(projectId);
    });
    const replacedFile = !!uploaded;
    uploaded = undefined;
    await sourceChanged(projectId);
    if (replacedFile) await removeUnreferencedFile(prior).catch(() => {});
    return { source: publicSource(next), affectedSteps: affected, warnings: analysis?.warnings ?? [] };
  } catch (error) { if (uploaded) await rm(/* turbopackIgnore: true */ uploaded.directory, { recursive: true, force: true }); if (error instanceof HttpError || request.signal.aborted) throw error; throw new HttpError(422, error instanceof Error ? error.message : "The source could not be updated."); }
}
export async function deleteSource(projectId: string, sourceId: string): Promise<void> {
  const source = await getSource(projectId, sourceId); mutableProject(projectId);
  const pipeline = (await import("./prepare-storage")).readPipeline(projectId)!;
  if (pipeline.definition.mainSourceId === sourceId || pipeline.definition.steps.some((step) => "sourceId" in step && step.sourceId === sourceId)) throw new HttpError(409, "This source is used by the pipeline. Change its main input or remove the referring Join/Union step before removing it.");
  withTransaction(getDatabase(), () => {
    mutableProject(projectId);
    getDatabase().prepare("DELETE FROM project_sources WHERE project_id = ? AND id = ?").run(projectId, sourceId);
    bumpPipelineVersion(projectId);
  });
  await sourceChanged(projectId); await removeUnreferencedFile(source).catch(() => {});
}
export async function readSourceJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send source edits as JSON.");
  try { return await new Response(await boundedBody(request, 64 * 1024)).json(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Source edits must contain valid JSON."); }
}
