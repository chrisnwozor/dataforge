import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyReport, type ReportTable, type SavedReport } from "@/lib/reports/schema";
import { createEmptyView } from "@/lib/explore/config";
import type { PaginatedReport } from "@/lib/reports/pagination";
import type { QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createExploreView, updateExploreView } from "@/lib/server/explore-views";
import { createReport, getReportRun, listReportRuns } from "@/lib/server/reports";
import { openReportExport, readReportPreview } from "@/lib/server/report-files";
import { cancelReportRun, clearReportResultCache, executeReportData, queryReportData, reportResultCacheKey, startReportRun, waitForReportRun, type ReportRunnerDependencies } from "@/lib/server/report-runner";
import { GET as download } from "@/app/api/projects/[id]/reports/[reportId]/runs/[runId]/download/route";
import { GET as getRun } from "@/app/api/projects/[id]/reports/[reportId]/runs/[runId]/route";

let directory: string, projectId: string, otherProjectId: string, model: SemanticModel;
const activeIds: string[] = [];
const category = { table: "product", column: "category" };
function project(id: string) {
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO projects (id,name,source_file,source_type,status,row_count,column_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "Report runner tests", "sales.csv", "CSV", "Ready", 2, 2, now, now);
}
function table(id = "sales-table", measure = "sales"): ReportTable {
  return {
    id, title: "Sales by Category", type: "table", data: { kind: "fields", rows: [category], values: [measure], filters: [], sort: [] },
    columns: [{ id: "category", label: "Category", width: 200, align: "left", format: "auto", binding: { kind: "attribute", attribute: category } },
      { id: "amount", label: "Amount", width: 100, align: "right", format: "currency", binding: { kind: "measure", measure } }],
    groups: [], subtotals: false, grandTotal: false, keepTogether: true, hideOnEmpty: false, conditionalFormats: [],
  };
}
function report(items: ReportTable[] = [table()]): SavedReport {
  const doc = createEmptyReport("Sales: Quarterly / Review");
  return createReport(projectId, { ...doc, definition: { ...doc.definition, items } });
}
const result = (rows = [{ a0: "Furniture", m0: 1234.5 }]): QueryResult => ({ columns: [{ key: "a0", name: "Category", type: "string", role: "attribute" }, { key: "m0", name: "Sales", type: "number", role: "measure" }], rows, rowCount: rows.length, truncated: false, elapsedMs: 7, fromCache: false, sql: "SELECT generated_only" });
function dependencies(patch: Partial<ReportRunnerDependencies> = {}): ReportRunnerDependencies {
  return { loadModel: vi.fn(async () => model), ready: vi.fn(async () => ({ run: { id: "successful-warehouse-run" } })),
    post: vi.fn(async () => Response.json(result())), export: vi.fn(async (format) => new TextEncoder().encode(`DataForge ${format} export\n`)), ...patch };
}
const context = (reportId: string, runId: string, id = projectId) => ({ params: Promise.resolve({ id, reportId, runId }) });
const request = (path = "http://localhost/api/run") => new Request(path);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-report-runner-")); vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  projectId = randomUUID(); otherProjectId = randomUUID(); project(projectId); project(otherProjectId); clearReportResultCache();
  model = { projectId, version: "model-one", factTableId: "fact", hierarchies: [],
    tables: [{ id: "fact", name: "fact_sales", schema: "dw", sqlName: "fact_sales", kind: "fact", keyColumnId: "fact:key", columns: [
      { id: "fact:key", tableId: "fact", name: "Key", sqlName: "Key", type: "number", role: "key" },
      { id: "sales", tableId: "fact", name: "Sales", sqlName: "Sales", type: "number", role: "measure-source" },
    ] }, { id: "product", name: "dim_product", schema: "dw", sqlName: "dim_product", kind: "dimension", keyColumnId: "product:key", columns: [
      { id: "product:key", tableId: "product", name: "Key", sqlName: "Key", type: "number", role: "key" },
      { id: "category", tableId: "product", name: "Category", sqlName: "Category", type: "string", role: "attribute" },
    ] }], relationships: [], measures: ["sales", "profit"].map((id) => ({ id, name: id === "sales" ? "Sales" : "Profit", expression: "SUM(fact_sales[Sales])", format: "currency", folder: "", description: "", isAuto: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })) };
});
afterEach(async () => {
  for (const id of activeIds.splice(0)) await waitForReportRun(id);
  clearReportResultCache(); closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

describe("report execution through the semantic POST API", () => {
  it("returns queued immediately, then persists exports, page preview, summary, and streamed downloads", async () => {
    const saved = report(), deps = dependencies();
    const run = await startReportRun(projectId, saved.id, { formats: ["pdf", "xlsx", "csv"] }, deps); activeIds.push(run.id);
    expect(run.status).toBe("queued"); expect(deps.post).not.toHaveBeenCalled();
    await waitForReportRun(run.id);
    const final = getReportRun(projectId, saved.id, run.id);
    expect(final).toMatchObject({ status: "succeeded", rowCount: 1, pageCount: 1, finishedAt: expect.any(String), trigger: "manual" });
    expect(Object.keys(final.filePaths)).toEqual(["pdf", "xlsx", "csv"]);
    const preview = readReportPreview(saved.id, run.id) as PaginatedReport;
    expect(preview.pages).toHaveLength(1);
    expect(preview.pages[0].elements.some((element) => element.kind === "tableRow" && element.cells.some((cell) => cell.text === "$1,234.50"))).toBe(true);
    const file = openReportExport(saved.id, run.id, "csv");
    try { expect(readFileSync(file.fd, "utf8")).toBe("DataForge csv export\n"); } finally { closeSync(file.fd); }
    const response = await download(request("http://localhost/api/download?format=csv"), context(saved.id, run.id));
    expect(response.status).toBe(200); expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("Sales-%20Quarterly%20-%20Review.csv");
    expect(await response.text()).toBe("DataForge csv export\n");
    expect((await (await getRun(request(), context(saved.id, run.id))).json()).preview.pages).toHaveLength(1);
    expect((await download(request("http://localhost/api/download?format=csv"), context(saved.id, run.id, otherProjectId))).status).toBe(404);
    expect((await download(request("http://localhost/api/download?format=exe"), context(saved.id, run.id))).status).toBe(400);
  });

  it("rejects a second active run for the same report and allows independent reports", async () => {
    const first = report(), second = report(); const deps = dependencies();
    const run = await startReportRun(projectId, first.id, { formats: ["csv"] }, deps); activeIds.push(run.id);
    await expect(startReportRun(projectId, first.id, {}, deps)).rejects.toMatchObject({ status: 409 });
    const other = await startReportRun(projectId, second.id, { formats: ["csv"] }, deps); activeIds.push(other.id);
    await Promise.all([waitForReportRun(run.id), waitForReportRun(other.id)]);
    expect(getReportRun(projectId, first.id, run.id).status).toBe("succeeded");
    expect(getReportRun(projectId, second.id, other.id).status).toBe("succeeded");
  });

  it("cancels in-flight semantic work, keeps the cancelled final state, and writes no exports", async () => {
    const saved = report(); let signal: AbortSignal | undefined;
    const deps = dependencies({ post: vi.fn(async (request) => { signal = request.signal; return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true })); }) });
    const run = await startReportRun(projectId, saved.id, {}, deps); activeIds.push(run.id);
    await tick(); expect(signal).toBeDefined();
    expect(cancelReportRun(projectId, saved.id, run.id).status).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
    await waitForReportRun(run.id);
    expect(getReportRun(projectId, saved.id, run.id)).toMatchObject({ status: "cancelled", error: "Report cancelled.", filePaths: {} });
    expect(deps.export).not.toHaveBeenCalled(); expect(readReportPreview(saved.id, run.id)).toBeNull();
  });

  it("records a failed API response without running later contexts or creating downloads", async () => {
    const saved = report([{ ...table(), grandTotal: true }]);
    const deps = dependencies({ post: vi.fn(async () => Response.json({ error: "The database query timed out." }, { status: 504 })) });
    const run = await startReportRun(projectId, saved.id, {}, deps); activeIds.push(run.id); await waitForReportRun(run.id);
    expect(getReportRun(projectId, saved.id, run.id)).toMatchObject({ status: "failed", error: "The database query timed out.", filePaths: {} });
    expect(deps.post).toHaveBeenCalledOnce(); expect(deps.export).not.toHaveBeenCalled();
    expect((await download(request("http://localhost/api/download?format=csv"), context(saved.id, run.id))).status).toBe(404);
  });

  it("marks scheduled work and sends the lowest-priority header through the existing query route", async () => {
    const saved = report(); const deps = dependencies();
    const run = await startReportRun(projectId, saved.id, { scheduled: true, formats: ["csv"] }, deps); activeIds.push(run.id); await waitForReportRun(run.id);
    expect(getReportRun(projectId, saved.id, run.id).trigger).toBe("scheduled");
    const posted = vi.mocked(deps.post).mock.calls[0][0];
    expect(posted.headers.get("X-DataForge-Query-Purpose")).toBe("reportScheduled");
    expect(await posted.json()).toMatchObject({ report: true, measures: ["sales"], limit: 100_000 });
    expect(vi.mocked(deps.post).mock.calls[0][1]).toMatchObject({ params: expect.any(Promise) });
  });

  it("batches different measures sharing a grouping and reuses the exact server result", async () => {
    const saved = report([table("first", "sales"), table("second", "profit")]);
    const post: ReportRunnerDependencies["post"] = vi.fn(async () => Response.json({ ...result(), columns: [...result().columns, { key: "m1", name: "Profit", type: "number", role: "measure" }], rows: [{ a0: "Furniture", m0: 1234.5, m1: 321 }] }));
    const data = await executeReportData(saved, {}, model, new AbortController().signal, post);
    expect(post).toHaveBeenCalledOnce();
    const query = await vi.mocked(post).mock.calls[0][0].json();
    expect(query.measures).toEqual(["sales", "profit"]);
    expect(data.items.first.result).toBe(data.items.second.result);
    expect(data.items.first.result.rows[0].m1).toBe(321);
  });

  it("computes subtotals from extra server contexts and never adds detail ratios", async () => {
    const saved = report([{ ...table(), groups: [category], subtotals: true, grandTotal: true }]);
    const post: ReportRunnerDependencies["post"] = vi.fn(async (request) => {
      const query = await request.clone().json() as SemanticQuery;
      return Response.json(query.rows.length ? result([{ a0: "Furniture", m0: 0.9 }, { a0: "Technology", m0: 0.1 }]) : { ...result(), columns: [result().columns[1]], rows: [{ m0: 0.25 }] });
    });
    const data = await executeReportData(saved, {}, model, new AbortController().signal, post);
    expect(post).toHaveBeenCalledTimes(2);
    expect(data.items["sales-table"].totals?.find((entry) => entry.key === "grand")?.result.rows[0].m0).toBe(0.25);
  });

  it("caps total displayed detail rows at 100,000 even if a driver returns extra rows", async () => {
    const saved = report([table("first"), table("second")]);
    const post: ReportRunnerDependencies["post"] = vi.fn(async () => Response.json(result(Array.from({ length: 100_001 }, (_, index) => ({ a0: `Category ${index}`, m0: index })))));
    const data = await executeReportData(saved, {}, model, new AbortController().signal, post);
    expect(data.items.first.result.rows).toHaveLength(100_000); expect(data.items.first.result.truncated).toBe(true);
    expect(data.items.second.result).toMatchObject({ rows: [], truncated: true }); expect(post).toHaveBeenCalledOnce();
  });

  it("returns cached data on a repeated run but invalidates a changed warehouse run or model", async () => {
    const saved = report(); const deps = dependencies();
    async function run() { const value = await startReportRun(projectId, saved.id, { formats: ["csv"] }, deps); activeIds.push(value.id); await waitForReportRun(value.id); return value; }
    await run(); await run(); expect(deps.post).toHaveBeenCalledOnce();
    vi.mocked(deps.ready).mockResolvedValue({ run: { id: "new-warehouse-run" } });
    await run(); expect(deps.post).toHaveBeenCalledTimes(2);
    model = { ...model, version: "model-two" };
    await run(); expect(deps.post).toHaveBeenCalledTimes(3);
  });

  it("detects a warehouse load changed mid-run instead of mixing its results", async () => {
    const saved = report(); const deps = dependencies();
    vi.mocked(deps.ready).mockResolvedValueOnce({ run: { id: "old" } }).mockResolvedValueOnce({ run: { id: "new" } });
    const run = await startReportRun(projectId, saved.id, {}, deps); activeIds.push(run.id); await waitForReportRun(run.id);
    expect(getReportRun(projectId, saved.id, run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/changed while this report was running/) });
    expect(deps.export).not.toHaveBeenCalled();
  });

  it("rejects unknown run fields, invalid parameters, and cross-project ownership before background work", async () => {
    const saved = report(), deps = dependencies();
    await expect(startReportRun(otherProjectId, saved.id, {}, deps)).rejects.toMatchObject({ status: 404 });
    await expect(startReportRun(projectId, saved.id, { params: { arbitrary: "x" } }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(startReportRun(projectId, saved.id, { sql: "SELECT 1" } as never, deps)).rejects.toMatchObject({ status: 400 });
    expect(listReportRuns(projectId, saved.id)).toHaveLength(0); expect(deps.post).not.toHaveBeenCalled();
  });

  it("does not send cancelled or incomplete query requests", async () => {
    const controller = new AbortController(); controller.abort(); const post = vi.fn();
    await expect(queryReportData(projectId, { measures: ["sales"], rows: [], filters: [], orderBy: [], limit: 1, hideUnknown: true }, controller.signal, false, post)).rejects.toMatchObject({ name: "AbortError" });
    expect(post).not.toHaveBeenCalled();
    await expect(queryReportData(projectId, { measures: ["sales"], rows: [], filters: [], orderBy: [], limit: 1, hideUnknown: true }, new AbortController().signal, false, vi.fn(async () => Response.json({ rows: [] })))).rejects.toMatchObject({ status: 502 });
  });
});

describe("versioned report result cache identity", () => {
  it("includes model, successful run, definition, parameters and current view configuration", () => {
    const definition = createEmptyReport().definition;
    const key = () => reportResultCacheKey("model", "run", definition, { category: ["East", "West"] }, [{ id: "view", config: { values: ["sales"] } }]);
    const original = key();
    expect(key()).toBe(original);
    expect(reportResultCacheKey("next-model", "run", definition, { category: ["East", "West"] }, [{ id: "view", config: { values: ["sales"] } }])).not.toBe(original);
    expect(reportResultCacheKey("model", "next-run", definition, { category: ["East", "West"] }, [{ id: "view", config: { values: ["sales"] } }])).not.toBe(original);
    expect(reportResultCacheKey("model", "run", { ...definition, retentionCount: 30 }, { category: ["East", "West"] }, [{ id: "view", config: { values: ["sales"] } }])).not.toBe(original);
    expect(reportResultCacheKey("model", "run", definition, { category: ["West"] }, [{ id: "view", config: { values: ["sales"] } }])).not.toBe(original);
    expect(reportResultCacheKey("model", "run", definition, { category: ["East", "West"] }, [{ id: "view", config: { values: ["profit"] } }])).not.toBe(original);
  });

  it("invalidates the real saved-view context after a view is edited", async () => {
    const view = createExploreView(projectId, { name: "Sales", config: { ...createEmptyView(), rows: [category], values: ["sales"] } });
    const item = { ...table(), data: { kind: "view" as const, viewId: view.id } };
    const saved = report([item]); const deps = dependencies();
    const first = await startReportRun(projectId, saved.id, { formats: ["csv"] }, deps); activeIds.push(first.id); await waitForReportRun(first.id);
    updateExploreView(projectId, view.id, { config: { ...view.config, values: ["profit"] } });
    const second = await startReportRun(projectId, saved.id, { formats: ["csv"] }, deps); activeIds.push(second.id); await waitForReportRun(second.id);
    expect(deps.post).toHaveBeenCalledTimes(2);
  });
});
