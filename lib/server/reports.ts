import { randomUUID } from "node:crypto";
import { z } from "zod";
import { reportDefinitionSchema, reportDocumentSchema, reportParameterValuesSchema, type ReportDocument, type ReportParameterValues, type SavedReport } from "@/lib/reports/schema";
import { getDatabase, withTransaction } from "./db";
import { boundedBody, HttpError } from "./http";
import { removeReportExports, reportExportFormatSchema, validateStoredExportPath, type ReportExportFormat } from "./report-files";

const identity = z.string().uuid();
const timestamp = z.string().datetime();
const nameSchema = z.string().trim().min(1).max(120);
const updateSchema = z.object({ name: nameSchema.optional(), description: z.string().max(2_000).optional(), definition: reportDefinitionSchema.optional(), updatedAt: timestamp.optional() }).strict()
  .refine((input) => Object.keys(input).some((key) => key !== "updatedAt"), "Provide report edits to save.");
const runStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const pathsSchema = z.object({ pdf: z.string().max(500).optional(), xlsx: z.string().max(500).optional(), csv: z.string().max(500).optional() }).strict();
const runPatchSchema = z.object({
  status: runStatusSchema.optional(), rowCount: z.number().int().min(0).max(100_000).optional(), pageCount: z.number().int().min(0).max(100_000).optional(),
  finishedAt: timestamp.nullable().optional(), error: z.string().max(4_000).nullable().optional(), filePaths: pathsSchema.optional(),
}).strict();
const timezone = z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; } }, "Choose a valid timezone.");
export const reportScheduleInputSchema = z.object({
  cron: z.string().trim().min(1).max(120), timezone, params: reportParameterValuesSchema.default({}),
  formats: z.array(reportExportFormatSchema).min(1).max(3).refine((value) => new Set(value).size === value.length, "Choose each format once."),
  enabled: z.boolean().default(true), lastRunAt: timestamp.nullable().optional(), nextRunAt: timestamp.nullable().optional(),
}).strict();
const schedulePatchSchema = z.object({
  cron: reportScheduleInputSchema.shape.cron.optional(), timezone: timezone.optional(), params: reportParameterValuesSchema.optional(),
  formats: reportScheduleInputSchema.shape.formats.optional(), enabled: z.boolean().optional(), lastRunAt: timestamp.nullable().optional(), nextRunAt: timestamp.nullable().optional(),
}).strict();

export interface ReportRun {
  id: string; reportId: string; projectId: string; status: z.infer<typeof runStatusSchema>; params: ReportParameterValues;
  rowCount: number; pageCount: number; startedAt: string; finishedAt: string | null; error: string | null;
  filePaths: Partial<Record<ReportExportFormat, string>>; ownerPid: number | null; trigger: "manual" | "scheduled";
}
export interface ReportSchedule {
  id: string; reportId: string; projectId: string; cron: string; timezone: string; params: ReportParameterValues;
  formats: ReportExportFormat[]; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null;
}
export type ReportListEntry = SavedReport & { lastRun: Pick<ReportRun, "status" | "startedAt"> | null; scheduleCount: number };

export function validateReportId(value: string): string {
  const parsed = identity.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid report ID.");
  return parsed.data;
}
function readReport(row: Record<string, unknown>): SavedReport {
  try {
    return { ...reportDocumentSchema.parse({ name: row.name, description: row.description, definition: JSON.parse(String(row.definition)) }),
      id: identity.parse(row.id), projectId: identity.parse(row.projectId), createdAt: timestamp.parse(row.createdAt), updatedAt: timestamp.parse(row.updatedAt) };
  } catch { throw new HttpError(500, "A saved report is invalid or uses an unsupported version. Its data has not been changed."); }
}
function validateViewReferences(projectId: string, document: ReportDocument): void {
  const statement = getDatabase().prepare("SELECT id FROM explore_views WHERE project_id = ? AND id = ?");
  for (const item of document.definition.items) {
    if ("data" in item && item.data.kind === "view" && !statement.get(projectId, item.data.viewId))
      throw new HttpError(400, "Choose an Explore view saved in this project. A referenced view may have been deleted.");
  }
}
export function listReports(projectId: string): ReportListEntry[] {
  return getDatabase().prepare("SELECT r.id, r.project_id AS projectId, r.name, r.description, r.definition, r.created_at AS createdAt, r.updated_at AS updatedAt, (SELECT rr.status FROM report_runs rr WHERE rr.report_id = r.id ORDER BY rr.started_at DESC, rr.id DESC LIMIT 1) AS lastStatus, (SELECT rr.started_at FROM report_runs rr WHERE rr.report_id = r.id ORDER BY rr.started_at DESC, rr.id DESC LIMIT 1) AS lastStartedAt, (SELECT COUNT(*) FROM report_schedules s WHERE s.report_id = r.id AND s.enabled = 1) AS scheduleCount FROM reports r WHERE r.project_id = ? ORDER BY r.updated_at DESC, r.id").all(projectId).map((row) => ({
    ...readReport(row), lastRun: row.lastStatus ? { status: runStatusSchema.parse(row.lastStatus), startedAt: timestamp.parse(row.lastStartedAt) } : null, scheduleCount: Number(row.scheduleCount),
  }));
}
export function getReport(projectId: string, reportId: string): SavedReport {
  const row = getDatabase().prepare("SELECT id, project_id AS projectId, name, description, definition, created_at AS createdAt, updated_at AS updatedAt FROM reports WHERE project_id = ? AND id = ?").get(projectId, validateReportId(reportId));
  if (!row) throw new HttpError(404, "Report not found in this project.");
  return readReport(row);
}
export function createReport(projectId: string, input: unknown): SavedReport {
  const parsed = reportDocumentSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a report name and a valid versioned definition.");
  const id = randomUUID(), now = new Date().toISOString();
  return withTransaction(getDatabase(), () => {
    validateViewReferences(projectId, parsed.data);
    getDatabase().prepare("INSERT INTO reports (id, project_id, name, description, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, projectId, parsed.data.name, parsed.data.description, JSON.stringify(parsed.data.definition), now, now);
    return getReport(projectId, id);
  });
}
export function updateReport(projectId: string, reportId: string, input: unknown): SavedReport {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide valid report edits and an optional saved updatedAt timestamp.");
  return withTransaction(getDatabase(), () => {
    const saved = getReport(projectId, reportId);
    if (parsed.data.updatedAt !== undefined && parsed.data.updatedAt !== saved.updatedAt) throw new HttpError(409, "This report changed in another tab. Reload its latest version before saving your edits.");
    const document = reportDocumentSchema.parse({ name: parsed.data.name ?? saved.name, description: parsed.data.description ?? saved.description, definition: parsed.data.definition ?? saved.definition });
    if (parsed.data.definition) validateViewReferences(projectId, document);
    const next = new Date(Math.max(Date.now(), Date.parse(saved.updatedAt) + 1)).toISOString();
    const result = getDatabase().prepare("UPDATE reports SET name = ?, description = ?, definition = ?, updated_at = ? WHERE project_id = ? AND id = ? AND updated_at = ?")
      .run(document.name, document.description, JSON.stringify(document.definition), next, projectId, reportId, saved.updatedAt);
    if (!result.changes) throw new HttpError(409, "This report changed in another tab. Reload its latest version before saving your edits.");
    return getReport(projectId, reportId);
  });
}
export function duplicateReport(projectId: string, reportId: string): SavedReport {
  const saved = getReport(projectId, reportId);
  return createReport(projectId, { name: `${saved.name.slice(0, 115)} copy`, description: saved.description,
    definition: { ...saved.definition, items: saved.definition.items.map((item) => ({ ...item, id: randomUUID() })) } });
}
export function deleteReport(projectId: string, reportId: string): void {
  getReport(projectId, reportId);
  if (getActiveReportRun(projectId, reportId)) throw new HttpError(409, "Cancel the active report run before deleting this report.");
  removeReportExports(reportId);
  getDatabase().prepare("DELETE FROM reports WHERE project_id = ? AND id = ?").run(projectId, reportId);
}

function readRun(row: Record<string, unknown>): ReportRun {
  try {
    const id = identity.parse(row.id), reportId = identity.parse(row.reportId);
    const filePaths = pathsSchema.parse(JSON.parse(String(row.filePaths)));
    for (const [format, path] of Object.entries(filePaths)) if (path && !validateStoredExportPath(reportId, id, reportExportFormatSchema.parse(format), path)) throw new Error("Invalid export path.");
    return { id, reportId, projectId: identity.parse(row.projectId), status: runStatusSchema.parse(row.status), params: reportParameterValuesSchema.parse(JSON.parse(String(row.params))),
      rowCount: z.number().int().nonnegative().parse(row.rowCount), pageCount: z.number().int().nonnegative().parse(row.pageCount), startedAt: timestamp.parse(row.startedAt),
      finishedAt: row.finishedAt === null ? null : timestamp.parse(row.finishedAt), error: row.error === null ? null : z.string().max(4_000).parse(row.error), filePaths,
      ownerPid: row.ownerPid === null ? null : z.number().int().positive().parse(row.ownerPid), trigger: z.enum(["manual", "scheduled"]).parse(row.trigger) };
  } catch { throw new HttpError(500, "A saved report run is invalid. Its data has not been changed."); }
}
const runSelect = "SELECT rr.id, rr.report_id AS reportId, r.project_id AS projectId, rr.status, rr.params, rr.row_count AS rowCount, rr.page_count AS pageCount, rr.started_at AS startedAt, rr.finished_at AS finishedAt, rr.error, rr.file_paths AS filePaths, rr.owner_pid AS ownerPid, rr.trigger_type AS trigger FROM report_runs rr JOIN reports r ON r.id = rr.report_id";
export function listReportRuns(projectId: string, reportId: string): ReportRun[] {
  getReport(projectId, reportId);
  return getDatabase().prepare(`${runSelect} WHERE r.project_id = ? AND rr.report_id = ? ORDER BY rr.started_at DESC, rr.id`).all(projectId, reportId).map(readRun);
}
export function getReportRun(projectId: string, reportId: string, runId: string): ReportRun {
  getReport(projectId, reportId);
  const row = getDatabase().prepare(`${runSelect} WHERE r.project_id = ? AND rr.report_id = ? AND rr.id = ?`).get(projectId, reportId, validateReportId(runId));
  if (!row) throw new HttpError(404, "Report run not found in this project.");
  return readRun(row);
}
export function getActiveReportRun(projectId: string, reportId: string): ReportRun | null {
  getReport(projectId, reportId);
  const row = getDatabase().prepare(`${runSelect} WHERE r.project_id = ? AND rr.report_id = ? AND rr.status IN ('queued', 'running') LIMIT 1`).get(projectId, reportId);
  return row ? readRun(row) : null;
}
export function createReportRun(projectId: string, reportId: string, input: { params?: ReportParameterValues; ownerPid?: number; trigger?: "manual" | "scheduled" } = {}): ReportRun {
  getReport(projectId, reportId);
  const params = reportParameterValuesSchema.safeParse(input.params ?? {});
  if (!params.success) throw new HttpError(400, "Provide valid report parameter values.");
  const id = randomUUID(), now = new Date().toISOString();
  try {
    getDatabase().prepare("INSERT INTO report_runs (id, report_id, status, params, row_count, page_count, started_at, finished_at, error, file_paths, owner_pid, trigger_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, reportId, "queued", JSON.stringify(params.data), 0, 0, now, null, null, "{}", input.ownerPid ?? process.pid, input.trigger ?? "manual");
  } catch (error) { if ((error as { code?: string }).code?.startsWith("ERR_SQLITE") && getActiveReportRun(projectId, reportId)) throw new HttpError(409, "A run is already active for this report."); throw error; }
  return getReportRun(projectId, reportId, id);
}
export function updateReportRun(projectId: string, reportId: string, runId: string, input: unknown): ReportRun {
  const parsed = runPatchSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide valid report run updates.");
  const saved = getReportRun(projectId, reportId, runId);
  const next = { ...saved, ...parsed.data };
  const transitions: Record<ReportRun["status"], ReportRun["status"][]> = { queued: ["queued", "running", "failed", "cancelled"], running: ["running", "succeeded", "failed", "cancelled"], succeeded: ["succeeded"], failed: ["failed"], cancelled: ["cancelled"] };
  if (!transitions[saved.status].includes(next.status)) throw new HttpError(409, "This report run has already finished or cannot enter that state.");
  for (const [format, path] of Object.entries(next.filePaths)) if (path && !validateStoredExportPath(reportId, runId, reportExportFormatSchema.parse(format), path)) throw new HttpError(400, "Report exports must stay inside their run folder.");
  if (["succeeded", "failed", "cancelled"].includes(next.status) && !next.finishedAt) next.finishedAt = new Date().toISOString();
  getDatabase().prepare("UPDATE report_runs SET status = ?, row_count = ?, page_count = ?, finished_at = ?, error = ?, file_paths = ? WHERE id = ? AND report_id = ?")
    .run(next.status, next.rowCount, next.pageCount, next.finishedAt, next.error, JSON.stringify(next.filePaths), runId, reportId);
  return getReportRun(projectId, reportId, runId);
}
export function deleteReportRun(projectId: string, reportId: string, runId: string): void {
  const run = getReportRun(projectId, reportId, runId);
  if (run.status === "queued" || run.status === "running") throw new HttpError(409, "Cancel the report run before deleting it.");
  removeReportExports(reportId, runId);
  getDatabase().prepare("DELETE FROM report_runs WHERE id = ? AND report_id = ?").run(runId, reportId);
}
export function pruneReportRuns(projectId: string, reportId: string, keep?: number): number {
  const report = getReport(projectId, reportId);
  const count = keep ?? report.definition.retentionCount;
  if (!Number.isInteger(count) || count < 1 || count > 1_000) throw new HttpError(400, "Choose a report retention count from 1 to 1,000.");
  const runs = listReportRuns(projectId, reportId).filter((run) => !["queued", "running"].includes(run.status)).slice(count);
  for (const run of runs) deleteReportRun(projectId, reportId, run.id);
  return runs.length;
}

function reportOwnerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Bootstrap recovery leaves leases belonging to any still-living Node process alone. */
export function recoverAbandonedReportRuns(isAlive: (pid: number) => boolean = reportOwnerIsAlive): number {
  const database = getDatabase();
  const active = database.prepare("SELECT id, owner_pid AS ownerPid FROM report_runs WHERE status IN ('queued', 'running')").all();
  const update = database.prepare("UPDATE report_runs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND owner_pid IS ? AND status IN ('queued', 'running')");
  let changed = 0;
  for (const row of active) {
    const ownerPid = typeof row.ownerPid === "number" && Number.isInteger(row.ownerPid) && row.ownerPid > 0 ? row.ownerPid : null;
    if (ownerPid !== null && isAlive(ownerPid)) continue;
    changed += Number(update.run("failed", new Date().toISOString(), "This report run was interrupted when its owning Node process stopped. Run the report again.", row.id, row.ownerPid).changes);
  }
  return changed;
}

function readSchedule(row: Record<string, unknown>): ReportSchedule {
  try {
    const parsed = reportScheduleInputSchema.parse({ cron: row.cron, timezone: row.timezone, params: JSON.parse(String(row.params)), formats: JSON.parse(String(row.formats)), enabled: row.enabled === 1, lastRunAt: row.lastRunAt, nextRunAt: row.nextRunAt });
    return { ...parsed, id: identity.parse(row.id), reportId: identity.parse(row.reportId), projectId: identity.parse(row.projectId), lastRunAt: parsed.lastRunAt ?? null, nextRunAt: parsed.nextRunAt ?? null };
  } catch { throw new HttpError(500, "A saved report schedule is invalid. Its data has not been changed."); }
}
const scheduleSelect = "SELECT s.id, s.report_id AS reportId, r.project_id AS projectId, s.cron, s.timezone, s.params, s.formats, s.enabled, s.last_run_at AS lastRunAt, s.next_run_at AS nextRunAt FROM report_schedules s JOIN reports r ON r.id = s.report_id";
export function listReportSchedules(projectId: string, reportId: string): ReportSchedule[] {
  getReport(projectId, reportId);
  return getDatabase().prepare(`${scheduleSelect} WHERE r.project_id = ? AND s.report_id = ? ORDER BY s.id`).all(projectId, reportId).map(readSchedule);
}
export function getReportSchedule(projectId: string, reportId: string, scheduleId: string): ReportSchedule {
  getReport(projectId, reportId);
  const row = getDatabase().prepare(`${scheduleSelect} WHERE r.project_id = ? AND s.report_id = ? AND s.id = ?`).get(projectId, reportId, validateReportId(scheduleId));
  if (!row) throw new HttpError(404, "Report schedule not found in this project.");
  return readSchedule(row);
}
export function createReportSchedule(projectId: string, reportId: string, input: unknown): ReportSchedule {
  getReport(projectId, reportId);
  const parsed = reportScheduleInputSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a cron schedule, valid timezone, parameters, and export formats.");
  const id = randomUUID(), value = parsed.data;
  getDatabase().prepare("INSERT INTO report_schedules (id, report_id, cron, timezone, params, formats, enabled, last_run_at, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, reportId, value.cron, value.timezone, JSON.stringify(value.params), JSON.stringify(value.formats), value.enabled ? 1 : 0, value.lastRunAt ?? null, value.nextRunAt ?? null);
  return getReportSchedule(projectId, reportId, id);
}
export function updateReportSchedule(projectId: string, reportId: string, scheduleId: string, input: unknown): ReportSchedule {
  const parsed = schedulePatchSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide valid report schedule edits.");
  const saved = getReportSchedule(projectId, reportId, scheduleId);
  const value = reportScheduleInputSchema.parse({ cron: saved.cron, timezone: saved.timezone, params: saved.params, formats: saved.formats, enabled: saved.enabled, lastRunAt: saved.lastRunAt, nextRunAt: saved.nextRunAt, ...parsed.data });
  getDatabase().prepare("UPDATE report_schedules SET cron = ?, timezone = ?, params = ?, formats = ?, enabled = ?, last_run_at = ?, next_run_at = ? WHERE id = ? AND report_id = ?")
    .run(value.cron, value.timezone, JSON.stringify(value.params), JSON.stringify(value.formats), value.enabled ? 1 : 0, value.lastRunAt ?? null, value.nextRunAt ?? null, scheduleId, reportId);
  return getReportSchedule(projectId, reportId, scheduleId);
}
export function deleteReportSchedule(projectId: string, reportId: string, scheduleId: string): void {
  getReportSchedule(projectId, reportId, scheduleId);
  getDatabase().prepare("DELETE FROM report_schedules WHERE id = ? AND report_id = ?").run(scheduleId, reportId);
}
export function listDueReportSchedules(now: string): ReportSchedule[] {
  timestamp.parse(now);
  return getDatabase().prepare(`${scheduleSelect} WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ? ORDER BY s.next_run_at, s.id`).all(now).map(readSchedule);
}
export function advanceReportSchedule(scheduleId: string, expectedNextRunAt: string | null, patch: { lastRunAt?: string | null; nextRunAt: string | null; enabled?: boolean }): boolean {
  validateReportId(scheduleId);
  const next = timestamp.nullable().parse(patch.nextRunAt), last = patch.lastRunAt === undefined ? undefined : timestamp.nullable().parse(patch.lastRunAt);
  const statement = last === undefined
    ? getDatabase().prepare("UPDATE report_schedules SET next_run_at = ?, enabled = COALESCE(?, enabled) WHERE id = ? AND next_run_at IS ?")
    : getDatabase().prepare("UPDATE report_schedules SET next_run_at = ?, enabled = COALESCE(?, enabled), last_run_at = ? WHERE id = ? AND next_run_at IS ?");
  const enabled = patch.enabled === undefined ? null : patch.enabled ? 1 : 0;
  const result = last === undefined ? statement.run(next, enabled, scheduleId, expectedNextRunAt) : statement.run(next, enabled, last, scheduleId, expectedNextRunAt);
  return result.changes === 1;
}

export async function readReportBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send report edits as JSON.");
  try { return await new Response(await boundedBody(request, 1024 * 1024)).json(); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "The report request is not valid JSON."); }
}
