import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEmptyReport, type ReportDocument, type SavedReport } from "@/lib/reports/schema";
import { createEmptyView } from "@/lib/explore/config";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createExploreView } from "@/lib/server/explore-views";
import { advanceReportSchedule, createReportRun, createReportSchedule, deleteReportRun, deleteReportSchedule, getActiveReportRun, getReportRun, getReportSchedule, listDueReportSchedules, listReportRuns, listReportSchedules, listReports, pruneReportRuns, recoverAbandonedReportRuns, updateReportRun, updateReportSchedule } from "@/lib/server/reports";
import { openReportExport, readReportPreview, removeReportExports, reportExportPath, sanitizeReportFilename, writeReportExport, writeReportPreview } from "@/lib/server/report-files";
import { GET as list, POST as create } from "@/app/api/projects/[id]/reports/route";
import { GET as open, PUT as update, DELETE as remove } from "@/app/api/projects/[id]/reports/[reportId]/route";
import { POST as duplicate } from "@/app/api/projects/[id]/reports/[reportId]/duplicate/route";

let directory: string, projectId: string, otherProjectId: string;
const context = (id: string, reportId: string = randomUUID()) => ({ params: Promise.resolve({ id, reportId }) });
const request = (body?: unknown, method = "POST") => new Request("http://localhost/api/projects/p/reports", { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function project(id: string) {
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO projects (id,name,source_file,source_type,status,row_count,column_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "Report tests", "sales.csv", "CSV", "Ready", 2, 2, now, now);
}
function document(name = "Sales report"): ReportDocument {
  const value = createEmptyReport(name);
  return { ...value, description: "A recurring review", definition: { ...value.definition, items: [{ id: "intro", type: "text", title: "Overview", content: "Plain <script>text</script>" }] } };
}
async function saved(input = document()): Promise<SavedReport> {
  const response = await create(request(input), context(projectId));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-report-storage-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory); vi.stubEnv("DATAFORGE_SECRET", "");
  projectId = randomUUID(); otherProjectId = randomUUID(); project(projectId); project(otherProjectId);
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("versioned project report storage", () => {
  it("adds all three tables to an existing database without replacing project or dashboard data", async () => {
    const report = await saved();
    closeDatabase();
    const existing = new DatabaseSync(join(directory, "dataforge.db"));
    existing.exec("DROP TABLE report_schedules; DROP TABLE report_runs; DROP TABLE reports"); existing.close();
    const db = getDatabase();
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    for (const table of ["reports", "report_runs", "report_schedules"]) expect(db.prepare("SELECT name FROM sqlite_master WHERE name = ? AND type = 'table'").get(table)?.name).toBe(table);
    expect((await open(request(undefined, "GET"), context(projectId, report.id))).status).toBe(404);
  });
  it("round-trips a definition without a warehouse connection or encryption key and supports all CRUD operations", async () => {
    expect(await (await list(request(undefined, "GET"), context(projectId))).json()).toEqual({ reports: [] });
    const report = await saved(); closeDatabase();
    expect(await (await open(request(undefined, "GET"), context(projectId, report.id))).json()).toEqual(report);
    const response = await update(request({ name: "  Updated  " }, "PUT"), context(projectId, report.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Updated", definition: report.definition });
    expect((await (await list(request(undefined, "GET"), context(projectId))).json()).reports[0]).toMatchObject({ name: "Updated", lastRun: null, scheduleCount: 0 });
    expect((await remove(request(undefined, "DELETE"), context(projectId, report.id))).status).toBe(204);
    expect((await open(request(undefined, "GET"), context(projectId, report.id))).status).toBe(404);
  });
  it("keeps reports, runs and schedules scoped to their owning project", async () => {
    const report = await saved();
    expect((await open(request(undefined, "GET"), context(otherProjectId, report.id))).status).toBe(404);
    expect((await update(request({ name: "Other" }, "PUT"), context(otherProjectId, report.id))).status).toBe(404);
    expect((await remove(request(undefined, "DELETE"), context(otherProjectId, report.id))).status).toBe(404);
    expect((await duplicate(request(), context(otherProjectId, report.id))).status).toBe(404);
    expect(() => createReportRun(otherProjectId, report.id)).toThrow(/not found/);
    expect(() => listReportSchedules(otherProjectId, report.id)).toThrow(/not found/);
  });
  it("duplicates independently and protects optimistic autosave revisions", async () => {
    const report = await saved();
    const first = await update(request({ name: "First", updatedAt: report.updatedAt }, "PUT"), context(projectId, report.id));
    const updated: SavedReport = await first.json();
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(report.updatedAt));
    expect((await update(request({ name: "Stale", updatedAt: report.updatedAt }, "PUT"), context(projectId, report.id))).status).toBe(409);
    const response = await duplicate(request(), context(projectId, report.id));
    const copy: SavedReport = await response.json();
    expect(response.status).toBe(201); expect(copy.id).not.toBe(report.id); expect(copy.name).toBe("First copy");
    expect(copy.definition.items[0]).toMatchObject({ ...report.definition.items[0], id: expect.any(String) });
    expect(copy.definition.items[0].id).not.toBe(report.definition.items[0].id);
  });
  it("rejects unversioned/unknown payloads and retains corrupt definitions for repair", async () => {
    for (const input of [{ ...document(), name: " " }, { ...document(), definition: { ...document().definition, version: 2 } }, { ...document(), sql: "SELECT passwords" }]) expect((await create(request(input), context(projectId))).status).toBe(400);
    const report = await saved();
    getDatabase().prepare("UPDATE reports SET definition = ? WHERE id = ?").run('{"version":999}', report.id);
    const response = await open(request(undefined, "GET"), context(projectId, report.id));
    expect(response.status).toBe(500); expect(await response.text()).toMatch(/unsupported version.*not been changed/);
    expect(getDatabase().prepare("SELECT definition FROM reports WHERE id = ?").get(report.id)?.definition).toBe('{"version":999}');
  });
  it("validates saved-view ownership while allowing unrelated repairs after a view is deleted", async () => {
    const own = createExploreView(projectId, { name: "Sales", config: { ...createEmptyView(), values: ["sales"] } });
    const foreign = createExploreView(otherProjectId, { name: "Other", config: { ...createEmptyView(), values: ["sales"] } });
    const input = document();
    input.definition.items = [{ id: "plot", title: "Sales", type: "chart", viz: "bar", height: 220, data: { kind: "view", viewId: foreign.id } }];
    expect((await create(request(input), context(projectId))).status).toBe(400);
    if (input.definition.items[0].type !== "chart") throw new Error("Chart expected");
    input.definition.items[0].data = { kind: "view", viewId: own.id };
    const report = await saved(input);
    getDatabase().prepare("DELETE FROM explore_views WHERE id = ?").run(own.id);
    expect((await open(request(undefined, "GET"), context(projectId, report.id))).status).toBe(200);
    expect((await update(request({ name: "Repair me" }, "PUT"), context(projectId, report.id))).status).toBe(200);
    expect((await update(request({ definition: report.definition }, "PUT"), context(projectId, report.id))).status).toBe(400);
  });
  it("parameterizes untrusted text and rejects malformed, oversized or non-JSON bodies", async () => {
    const report = await saved(document("Robert'); DROP TABLE projects;--"));
    expect(report.name).toContain("DROP TABLE");
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    expect((await create(new Request("http://localhost", { method: "POST", body: "{}" }), context(projectId))).status).toBe(415);
    expect((await create(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), context(projectId))).status).toBe(400);
    expect((await create(request({ large: "x".repeat(1024 * 1024) }), context(projectId))).status).toBe(413);
    expect((await open(request(undefined, "GET"), context(projectId, "invalid"))).status).toBe(400);
  });
});

describe("report run records and retention", () => {
  it("enforces one active run, valid transitions, and immutable final status", async () => {
    const report = await saved();
    const run = createReportRun(projectId, report.id, { params: { category: ["Furniture"] } });
    expect(run).toMatchObject({ status: "queued", params: { category: ["Furniture"] }, trigger: "manual", ownerPid: process.pid });
    expect(() => createReportRun(projectId, report.id)).toThrow(/already active/);
    expect(() => updateReportRun(projectId, report.id, run.id, { status: "succeeded" })).toThrow(/cannot enter/);
    updateReportRun(projectId, report.id, run.id, { status: "running" });
    const finished = updateReportRun(projectId, report.id, run.id, { status: "succeeded", rowCount: 2000, pageCount: 50 });
    expect(finished.finishedAt).not.toBeNull();
    expect(() => updateReportRun(projectId, report.id, run.id, { status: "running" })).toThrow(/already finished/);
    expect(getActiveReportRun(projectId, report.id)).toBeNull();
    expect(() => getReportRun(otherProjectId, report.id, run.id)).toThrow(/not found/);
    expect(() => updateReportRun(projectId, report.id, run.id, { rowCount: 100001 })).toThrow(/valid report run/);
    expect(listReports(projectId)[0].lastRun?.status).toBe("succeeded");
  });
  it("blocks active deletion, prunes only completed runs and removes their exports", async () => {
    const report = await saved();
    const finishedIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const run = createReportRun(projectId, report.id);
      const path = writeReportExport(report.id, run.id, "csv", new TextEncoder().encode(`sales\n${index}\n`));
      updateReportRun(projectId, report.id, run.id, { status: "running" });
      updateReportRun(projectId, report.id, run.id, { status: "succeeded", filePaths: { csv: path } });
      getDatabase().prepare("UPDATE report_runs SET started_at = ? WHERE id = ?").run(`2026-01-0${index + 1}T00:00:00.000Z`, run.id);
      finishedIds.push(run.id);
    }
    const active = createReportRun(projectId, report.id);
    expect(() => deleteReportRun(projectId, report.id, active.id)).toThrow(/Cancel/);
    expect((await remove(request(undefined, "DELETE"), context(projectId, report.id))).status).toBe(409);
    expect(pruneReportRuns(projectId, report.id, 1)).toBe(2);
    expect(listReportRuns(projectId, report.id)).toHaveLength(2);
    expect(() => openReportExport(report.id, finishedIds[0], "csv")).toThrow(/no longer available/);
    expect(getReportRun(projectId, report.id, active.id).status).toBe("queued");
    updateReportRun(projectId, report.id, active.id, { status: "cancelled" });
    expect((await remove(request(undefined, "DELETE"), context(projectId, report.id))).status).toBe(204);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM report_runs").get()?.n).toBe(0);
  });
  it("rejects stored export path traversal and unsupported file formats", async () => {
    const report = await saved(); const run = createReportRun(projectId, report.id);
    expect(() => updateReportRun(projectId, report.id, run.id, { filePaths: { pdf: "../../.env.local" } })).toThrow(/inside their run folder/);
    expect(() => updateReportRun(projectId, report.id, run.id, { filePaths: { exe: "x" } })).toThrow(/valid report run/);
    getDatabase().prepare("UPDATE report_runs SET file_paths = ? WHERE id = ?").run('{"pdf":"../../.env.local"}', run.id);
    expect(() => getReportRun(projectId, report.id, run.id)).toThrow(/invalid.*not been changed/);
  });
  it("recovers dead and unowned runs without interfering with a live process lease", async () => {
    const report = await saved(); const second = await saved(document("Second")); const third = await saved(document("Third"));
    const dead = createReportRun(projectId, report.id, { ownerPid: 1111 });
    const live = createReportRun(projectId, second.id, { ownerPid: 2222 });
    const unowned = createReportRun(projectId, third.id);
    getDatabase().prepare("UPDATE report_runs SET owner_pid = ? WHERE id = ?").run(null, unowned.id);
    updateReportRun(projectId, report.id, dead.id, { status: "running" });
    const alive = vi.fn((pid: number) => pid === 2222);
    expect(recoverAbandonedReportRuns(alive)).toBe(2);
    expect(getReportRun(projectId, report.id, dead.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/interrupted.*Node process stopped/), finishedAt: expect.any(String) });
    expect(getReportRun(projectId, third.id, unowned.id).status).toBe("failed");
    expect(getReportRun(projectId, second.id, live.id).status).toBe("queued");
    expect(recoverAbandonedReportRuns(alive)).toBe(0);
    expect(() => createReportRun(projectId, report.id)).not.toThrow();
    expect(() => createReportRun(projectId, second.id)).toThrow(/already active/);
  });
});

describe("schedule persistence and atomic advancement", () => {
  it("scopes CRUD, lists due schedules, advances once, and preserves schedule badges", async () => {
    const report = await saved();
    const schedule = createReportSchedule(projectId, report.id, { cron: "0 9 * * 1", timezone: "America/New_York", params: { category: "Furniture" }, formats: ["pdf", "xlsx"], enabled: true, nextRunAt: "2026-11-02T14:00:00.000Z" });
    expect(listReports(projectId)[0].scheduleCount).toBe(1);
    expect(listDueReportSchedules("2026-11-02T13:59:00.000Z")).toEqual([]);
    expect(listDueReportSchedules("2026-11-02T14:00:00.000Z")[0]).toEqual(schedule);
    expect(advanceReportSchedule(schedule.id, schedule.nextRunAt, { lastRunAt: "2026-11-02T14:00:00.000Z", nextRunAt: "2026-11-09T14:00:00.000Z" })).toBe(true);
    expect(advanceReportSchedule(schedule.id, schedule.nextRunAt, { nextRunAt: "2026-11-16T14:00:00.000Z" })).toBe(false);
    const disabled = updateReportSchedule(projectId, report.id, schedule.id, { enabled: false });
    expect(disabled.enabled).toBe(false); expect(disabled.params).toEqual({ category: "Furniture" });
    expect(listDueReportSchedules("2027-01-01T00:00:00.000Z")).toEqual([]);
    expect(() => getReportSchedule(otherProjectId, report.id, schedule.id)).toThrow(/not found/);
    deleteReportSchedule(projectId, report.id, schedule.id);
    expect(listReportSchedules(projectId, report.id)).toEqual([]);
  });
  it("rejects malformed schedules, params and unsupported timezones", async () => {
    const report = await saved();
    for (const input of [
      { cron: "", timezone: "UTC", formats: ["pdf"] }, { cron: "0 9 * * *", timezone: "Not/real", formats: ["pdf"] },
      { cron: "0 9 * * *", timezone: "UTC", formats: ["exe"] }, { cron: "0 9 * * *", timezone: "UTC", formats: ["pdf", "pdf"] },
      { cron: "0 9 * * *", timezone: "UTC", formats: ["pdf"], params: { arbitrary: { sql: "SELECT 1" } } },
    ]) expect(() => createReportSchedule(projectId, report.id, input)).toThrow(/valid timezone/);
  });
});

describe("report export path safety", () => {
  it("writes only canonical UUID run paths and opens regular files without exposing arbitrary stored paths", async () => {
    const report = await saved(); const run = createReportRun(projectId, report.id);
    const relative = writeReportExport(report.id, run.id, "csv", new TextEncoder().encode("Sales\n2000\n"));
    expect(relative).toBe(`exports/${report.id}/${run.id}/report.csv`);
    const file = openReportExport(report.id, run.id, "csv");
    try { expect(file.size).toBe(11); expect(readFileSync(file.fd, "utf8")).toBe("Sales\n2000\n"); } finally { closeSync(file.fd); }
    expect(() => reportExportPath("../escape", run.id, "csv", true)).toThrow(/Invalid report/);
    expect(() => reportExportPath(report.id, run.id, "exe" as "csv", true)).toThrow(/Choose PDF/);
    removeReportExports(report.id, run.id); expect(() => openReportExport(report.id, run.id, "csv")).toThrow(/no longer available/);
  });
  it("rejects symlinked exports roots and final files without touching their targets", async () => {
    const report = await saved(); const run = createReportRun(projectId, report.id);
    const outside = mkdtempSync(join(tmpdir(), "dataforge-report-outside-"));
    try {
      symlinkSync(outside, join(directory, "exports"), "dir");
      expect(() => writeReportExport(report.id, run.id, "pdf", new Uint8Array([1]))).toThrow(/regular directory/);
      rmSync(join(directory, "exports"));
      const path = reportExportPath(report.id, run.id, "pdf", true);
      symlinkSync(join(directory, "dataforge.db"), path, "file");
      expect(() => writeReportExport(report.id, run.id, "pdf", new Uint8Array([1]))).toThrow(/cannot replace a link/);
      expect(() => openReportExport(report.id, run.id, "pdf")).toThrow(/no longer available/);
      expect(lstatSync(join(directory, "dataforge.db")).size).toBeGreaterThan(0);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it("sanitizes download labels for Windows-reserved names and control characters", () => {
    expect(sanitizeReportFilename('Sales: Q4 / 2024?')).toBe("Sales- Q4 - 2024-");
    expect(sanitizeReportFilename("CON")).toBe("report");
    expect(sanitizeReportFilename("NUL.txt")).toBe("report");
    expect(sanitizeReportFilename(".. ")).toBe("report");
    expect(sanitizeReportFilename("x\r\nHeader: injected")).not.toMatch(/[\r\n:]/);
    expect(sanitizeReportFilename("x".repeat(200))).toHaveLength(100);
  });
  it("stores bounded preview JSON in the same run folder and rejects preview symlinks", async () => {
    const report = await saved(); const run = createReportRun(projectId, report.id);
    expect(readReportPreview(report.id, run.id)).toBeNull();
    const preview = { pages: [{ elements: [{ type: "text", text: "Sales <plain>" }] }], rowCount: 2000 };
    writeReportPreview(report.id, run.id, preview);
    expect(readReportPreview(report.id, run.id)).toEqual(preview);
    const path = join(directory, "exports", report.id, run.id, "preview.json");
    rmSync(path); symlinkSync(join(directory, "dataforge.db"), path, "file");
    expect(() => readReportPreview(report.id, run.id)).toThrow(/cannot use a link/);
    expect(() => writeReportPreview(report.id, run.id, preview)).toThrow(/cannot replace a link/);
  });
});
