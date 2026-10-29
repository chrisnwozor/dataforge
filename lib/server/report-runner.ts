import { createHash } from "node:crypto";
import { z } from "zod";
import { POST as queryPOST } from "@/app/api/projects/[id]/query/route";
import { generateReportExport } from "@/lib/reports/export";
import { paginateReport, type ReportExecutionData, type PaginatedReport } from "@/lib/reports/pagination";
import { planReportQueries } from "@/lib/reports/plan";
import { validateReportParameters } from "@/lib/reports/parameters";
import { reportParameterValuesSchema, type SavedReport } from "@/lib/reports/schema";
import type { QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { normalizedJson } from "@/lib/semantic/query/cache";
import { listExploreViews } from "./explore-views";
import { getSemanticModel, requireSemanticReady } from "./semantic";
import { HttpError } from "./http";
import { createReportRun, getReport, getReportRun, pruneReportRuns, updateReportRun, type ReportRun } from "./reports";
import { removeReportExports, reportExportFormatSchema, writeReportExport, writeReportPreview, type ReportExportFormat } from "./report-files";

export const reportRunInputSchema = z.object({
  params: reportParameterValuesSchema.default({}),
  formats: z.array(reportExportFormatSchema).min(1).max(3).refine((values) => new Set(values).size === values.length, "Choose each format once.").default(["pdf", "xlsx", "csv"]),
}).strict();
type RunInput = z.input<typeof reportRunInputSchema> & { scheduled?: boolean };
interface ActiveReport { controller: AbortController; done: Promise<void>; projectId: string; reportId: string }
interface CacheEntry { data: ReportExecutionData; bytes: number; expires: number }
const processState = globalThis as typeof globalThis & { dataforgeReportWork?: Map<string, ActiveReport>; dataforgeReportResults?: Map<string, CacheEntry> };
const active = processState.dataforgeReportWork ??= new Map();
const cache = processState.dataforgeReportResults ??= new Map();
const ROW_LIMIT = 100_000;

export interface ReportRunnerDependencies {
  loadModel(projectId: string): Promise<SemanticModel>;
  ready(projectId: string): Promise<{ run: { id: string } }>;
  post: typeof queryPOST;
  export: typeof generateReportExport;
}
const defaults: ReportRunnerDependencies = {
  loadModel: getSemanticModel,
  ready: async (id) => requireSemanticReady(id),
  post: queryPOST,
  export: generateReportExport,
};

export function reportResultCacheKey(modelVersion: string, runId: string, definition: SavedReport["definition"], params: unknown, views: unknown = []): string {
  return createHash("sha256").update(normalizedJson({ modelVersion, runId, definition, params, views })).digest("hex");
}
export function clearReportResultCache(): void { cache.clear(); }
function cachedData(key: string): ReportExecutionData | undefined {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  if (entry.expires < Date.now()) return;
  cache.set(key, entry);
  return entry.data;
}
function cacheData(key: string, data: ReportExecutionData): void {
  const bytes = JSON.stringify(data).length * 2;
  if (bytes > 32 * 1024 * 1024) return;
  cache.delete(key); cache.set(key, { data, bytes, expires: Date.now() + 120_000 });
  let total = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cache.size > 8 || total > 32 * 1024 * 1024) {
    const first = cache.keys().next().value!; total -= cache.get(first)!.bytes; cache.delete(first);
  }
}
const checkCancelled = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException("Report cancelled.", "AbortError"); };

/** Calls the existing POST handler, including its validation, cache, compiler and SQL queue. */
export async function queryReportData(projectId: string, query: SemanticQuery, signal: AbortSignal, scheduled = false, post: typeof queryPOST = queryPOST): Promise<QueryResult> {
  checkCancelled(signal);
  const request = new Request(`http://dataforge.internal/api/projects/${encodeURIComponent(projectId)}/query`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-DataForge-Query-Purpose": scheduled ? "reportScheduled" : "report" },
    body: JSON.stringify({ ...query, report: true }), signal,
  });
  const response = await post(request, { params: Promise.resolve({ id: projectId }) });
  const body = await response.json();
  checkCancelled(signal);
  if (!response.ok) throw new HttpError(response.status, typeof body?.error === "string" ? body.error : "This report query could not be completed.");
  if (!Array.isArray(body?.rows) || !Array.isArray(body?.columns)) throw new HttpError(502, "A report query returned an incomplete response.");
  return body as QueryResult;
}

/** One query at a time per report; the shared scheduler enforces one SQL lease per project. */
export async function executeReportData(report: SavedReport, params: unknown, model: SemanticModel, signal: AbortSignal, post: typeof queryPOST = queryPOST, scheduled = false): Promise<ReportExecutionData> {
  const values = validateReportParameters(report.definition, params, model);
  const views = listExploreViews(report.projectId);
  const plans = planReportQueries(report.definition, values, views, model);
  const data: ReportExecutionData = { items: {}, parameters: values, runAt: new Date().toISOString() };
  const contexts = new Map<string, { result: QueryResult; limit: number }>();
  let remaining = ROW_LIMIT;
  let retainedContextRows = 0;
  let retainedContextBytes = 0;
  const execute = async (query: SemanticQuery, limit: number): Promise<QueryResult> => {
    checkCancelled(signal);
    const bounded = { ...query, report: true, limit: Math.max(1, Math.min(limit, ROW_LIMIT)) };
    const key = normalizedJson({ ...bounded, columns: bounded.columns ?? [], limit: undefined });
    const cached = contexts.get(key);
    if (cached && cached.limit >= bounded.limit) return cached.result.rows.length > bounded.limit ? { ...cached.result, rows: cached.result.rows.slice(0, bounded.limit), rowCount: bounded.limit, truncated: true } : cached.result;
    if (retainedContextRows >= ROW_LIMIT * 4) throw new HttpError(413, "This report has too many subtotal contexts. Reduce its groups or split it into separate reports.");
    const result = await queryReportData(report.projectId, bounded, signal, scheduled, post);
    if (result.rows.length > bounded.limit) { result.rows = result.rows.slice(0, bounded.limit); result.rowCount = result.rows.length; result.truncated = true; }
    retainedContextBytes += JSON.stringify(result).length * 2;
    if (retainedContextBytes > 64 * 1024 * 1024) throw new HttpError(413, "This report contains too much data for one export. Reduce its columns or split it into separate reports.");
    contexts.set(key, { result, limit: bounded.limit }); retainedContextRows += result.rows.length;
    return result;
  };
  for (const plan of plans) {
    checkCancelled(signal);
    if (!remaining) {
      data.items[plan.itemId] = { result: { columns: [], rows: [], rowCount: 0, truncated: true, elapsedMs: 0, fromCache: false, sql: "" }, rows: [...plan.main.rows, ...(plan.main.columns ?? [])], measures: plan.main.measures };
      continue;
    }
    // Exact query contexts are reused; a later item still consumes its own displayed-row budget.
    const result = await execute(plan.main, remaining);
    remaining -= result.rows.length;
    const totals = [];
    for (const total of plan.totals) {
      const result = await execute(total.query, ROW_LIMIT);
      totals.push({ key: total.key, groupBy: total.groupBy, result });
    }
    data.items[plan.itemId] = { result, totals, rows: [...plan.main.rows, ...(plan.main.columns ?? [])], measures: plan.main.measures };
  }
  return data;
}

async function performReportRun(report: SavedReport, run: ReportRun, formats: ReportExportFormat[], controller: AbortController, scheduled: boolean, dependencies: ReportRunnerDependencies): Promise<void> {
  const { signal } = controller;
  const timeout = setTimeout(() => controller.abort(new Error("Report exceeded its ten-minute overall timeout.")), 10 * 60_000);
  try {
    checkCancelled(signal);
    updateReportRun(report.projectId, report.id, run.id, { status: "running" });
    const hasData = report.definition.items.some((item) => "data" in item);
    const ready = hasData ? await dependencies.ready(report.projectId) : null;
    const model = hasData ? await dependencies.loadModel(report.projectId) : undefined;
    const params = validateReportParameters(report.definition, run.params, model);
    const views = listExploreViews(report.projectId).map(({ id, config }) => ({ id, config }));
    const cacheKey = reportResultCacheKey(model?.version ?? "text-v1", ready?.run.id ?? "no-data", report.definition, params, views);
    const cached = cachedData(cacheKey);
    const data = cached ? { ...cached, runAt: new Date().toISOString() } : model ? await executeReportData(report, params, model, signal, dependencies.post, scheduled) : { items: {}, parameters: params, runAt: new Date().toISOString() };
    if (!cached) cacheData(cacheKey, data);
    checkCancelled(signal);
    // Do not mix rows from different warehouse loads or semantic revisions.
    if (ready && model) {
      const latest = await dependencies.ready(report.projectId);
      const latestModel = await dependencies.loadModel(report.projectId);
      if (latest.run.id !== ready.run.id || latestModel.version !== model.version) throw new HttpError(409, "The warehouse or semantic model changed while this report was running. Run the report again.");
    }
    const preview: PaginatedReport = paginateReport(report.definition, data, model, report.name);
    const filePaths: ReportRun["filePaths"] = {};
    for (const format of formats) {
      checkCancelled(signal);
      const bytes = await dependencies.export(format, { definition: report.definition, data, model, name: report.name, signal });
      checkCancelled(signal);
      filePaths[format] = writeReportExport(report.id, run.id, format, bytes);
      // Yield between formats so cancellation and interactive requests can progress.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    checkCancelled(signal);
    writeReportPreview(report.id, run.id, preview);
    updateReportRun(report.projectId, report.id, run.id, { status: "succeeded", rowCount: Math.min(ROW_LIMIT, preview.rowCount), pageCount: preview.pages.length, filePaths });
    pruneReportRuns(report.projectId, report.id);
  } catch (error) {
    const message = signal.aborted ? signal.reason instanceof Error && signal.reason.message.includes("ten-minute") ? signal.reason.message : "Report cancelled." : error instanceof Error ? error.message : "The report could not be completed.";
    try { removeReportExports(report.id, run.id); } catch { /* Retention can remove any incomplete files later. */ }
    try { updateReportRun(report.projectId, report.id, run.id, { status: signal.aborted ? "cancelled" : "failed", error: message.slice(0, 4000) }); } catch { /* A terminal run keeps its recorded state. */ }
  } finally { clearTimeout(timeout); active.delete(run.id); }
}

/** Validation/storage complete before returning; execution begins in the background. */
export async function startReportRun(projectId: string, reportId: string, input: RunInput = {}, dependencies: ReportRunnerDependencies = defaults): Promise<ReportRun> {
  const { scheduled = false, ...body } = input;
  const parsed = reportRunInputSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "Choose valid report parameters and PDF, Excel, or CSV formats.");
  if (active.size >= 16) throw new HttpError(503, "The report queue is full. Wait for an active report to finish, then try again.");
  const report = getReport(projectId, reportId);
  let params;
  try { params = validateReportParameters(report.definition, parsed.data.params); }
  catch (error) { throw new HttpError(400, error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid report parameters." : "Invalid report parameters."); }
  const run = createReportRun(projectId, reportId, { params, trigger: scheduled ? "scheduled" : "manual" });
  const controller = new AbortController();
  const done = new Promise<void>((resolve) => setImmediate(resolve)).then(() => performReportRun(report, run, parsed.data.formats, controller, scheduled, dependencies));
  active.set(run.id, { projectId, reportId, controller, done });
  return run;
}
export function cancelReportRun(projectId: string, reportId: string, runId: string): ReportRun {
  const run = getReportRun(projectId, reportId, runId);
  if (run.status !== "queued" && run.status !== "running") return run;
  const work = active.get(runId);
  if (!work) throw new HttpError(409, "This report is running in another Node process. Use the persistent single-process deployment to cancel it.");
  work.controller.abort();
  return updateReportRun(projectId, reportId, runId, { status: "cancelled", error: "Report cancelled." });
}
export async function waitForReportRun(runId: string): Promise<void> { await active.get(runId)?.done; }
