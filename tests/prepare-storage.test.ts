import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { profileFile } from "@/lib/profiler";
import { profileReport, readColumnProfiles, saveProjectProfile, findProject, updateColumnOverrides } from "@/lib/server/projects";
import { ensureDefaultPipeline, readPipeline, readPipelineBody, savePipeline, listPreparationRuns } from "@/lib/server/prepare-storage";
import { cancelPreparedProfile, ensurePreparedDataset, executePreparedDataset, preparationRejectsResponse, preparationStatus, previewPipeline, queuePreparedProfile, readQuality, requirePreparedProfile, waitForPreparation } from "@/lib/server/prepare";
import { getOrCreateModel, readSavedModel, saveEditedModel } from "@/lib/server/models";
import { pipelineDefinitionSchema } from "@/lib/prepare/schema";
import { removeMissingPreparedAssignments } from "@/lib/prepare/reconcile-model";
import { validateModel } from "@/lib/modeling/validate";
import { GET, PUT } from "@/app/api/projects/[id]/pipeline/route";
import { GET as qualityGET } from "@/app/api/projects/[id]/pipeline/quality/route";
import { POST as previewPOST } from "@/app/api/projects/[id]/pipeline/preview/route";

let directory: string;
const projects: string[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "dataforge-preparation-storage-")); vi.stubEnv("DATAFORGE_DATA_DIR", directory); });
afterEach(async () => {
  for (const id of projects.splice(0)) { await cancelPreparedProfile(id).catch(() => {}); await waitForPreparation(id).catch(() => {}); }
  closeDatabase(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});
const inputCsv = "Order ID,Customer Name,Sales,Quantity\nO1, Alice ,10,1\nO2,Bob,20,2\nO3,Alice,10,1\n";
async function project(contents = inputCsv) {
  const id = randomUUID(); projects.push(id);
  const path = join(directory, "uploads", id); await mkdir(path, { recursive: true });
  const filePath = join(path, "orders.csv"); await writeFile(filePath, contents);
  const profile = await profileFile(filePath, "CSV");
  const now = new Date().toISOString();
  saveProjectProfile({ id, name: "Preparation fixture", sourceFile: "orders.csv", sourceType: "CSV", status: "Ready", rowCount: profile.rowCount, columnCount: profile.columnCount, duplicateRowCount: profile.duplicateRowCount, totalNullCells: profile.totalNullCells, createdAt: now, updatedAt: now }, profile);
  await writeFile(join(path, "profile-report.json"), JSON.stringify(profileReport(profile)));
  return id;
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (body: unknown, method = "POST") => new Request("http://localhost/api/projects/fixture/pipeline", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function edited(id: string, steps: unknown[]) {
  const saved = await ensureDefaultPipeline(id);
  return savePipeline(id, { version: saved.version, definition: { ...saved.definition, steps } });
}

describe("additive preparation storage and legacy migration", () => {
  it("leaves legacy profiling alone until preparation is explicitly opened, then creates one implicit passthrough", async () => {
    const id = await project();
    expect(await requirePreparedProfile(id)).toBeNull();
    expect(getDatabase().prepare("SELECT COUNT(*) AS count FROM project_sources").get()?.count).toBe(0);
    const initial = readColumnProfiles(id);
    const [first, second] = await Promise.all([ensureDefaultPipeline(id), ensureDefaultPipeline(id)]);
    expect(first).toEqual(second); expect(first.version).toBe(1); expect(first.definition.steps).toEqual([]); expect(first.profiledVersion).toBe(1);
    expect(readColumnProfiles(id)).toEqual(initial);
    const sources = getDatabase().prepare("SELECT file_path, columns FROM project_sources WHERE project_id = ?").all(id);
    expect(sources).toHaveLength(1); expect(String(sources[0].file_path)).toContain(`${id}/sources/`);
    expect(await readFile(String(sources[0].file_path), "utf8")).toBe(inputCsv);
  });
  it("validates optimistic versions, future JSON, references and bounded request bodies", async () => {
    const id = await project(), original = await ensureDefaultPipeline(id);
    await expect(savePipeline(id, { ...original, definition: original.definition })).rejects.toMatchObject({ status: 400 });
    await expect(savePipeline(id, { version: 9, definition: original.definition })).rejects.toMatchObject({ status: 409 });
    await expect(savePipeline(id, { version: 1, definition: { ...original.definition, mainSourceId: randomUUID() } })).rejects.toMatchObject({ status: 400 });
    await expect(savePipeline(id, { version: 1, definition: { ...original.definition, version: 2 } })).rejects.toMatchObject({ status: 400 });
    await expect(readPipelineBody(new Request("http://localhost", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "{}" }))).rejects.toMatchObject({ status: 415 });
    getDatabase().prepare("UPDATE project_pipelines SET definition = ? WHERE project_id = ?").run('{"version":9}', id);
    expect(() => readPipeline(id)).toThrow("unsupported version");
    expect(getDatabase().prepare("SELECT definition FROM project_pipelines WHERE project_id = ?").get(id)?.definition).toBe('{"version":9}');
  });
  it("blocks pipeline mutations while a warehouse load owns the project", async () => {
    const id = await project(), saved = await ensureDefaultPipeline(id);
    getDatabase().prepare("INSERT INTO runs (id, project_id, status, mode, started_at, options_json) VALUES (?, ?, ?, ?, ?, ?)").run(randomUUID(), id, "queued", "full", new Date().toISOString(), '{}');
    await expect(savePipeline(id, { version: saved.version, definition: saved.definition })).rejects.toMatchObject({ status: 409 });
    await expect(queuePreparedProfile(id)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects legacy source links escaping the project directory", async () => {
    const id = await project();
    await rm(join(directory, "uploads", id, "orders.csv"));
    const outside = join(directory, "outside.csv"); await writeFile(outside, inputCsv);
    await symlink(outside, join(directory, "uploads", id, "orders.csv"));
    await expect(ensureDefaultPipeline(id)).rejects.toMatchObject({ status: 422 });
  });
});

describe("prepared profiling, preview and quality", () => {
  it("uses the same row transforms for bounded before/after previews and full prepared profiling", async () => {
    const id = await project();
    const saved = await edited(id, [
      { id: "trim", type: "cleanText", columns: ["Customer Name"], operations: ["trim", "upper"] },
      { id: "derive", type: "derive", column: "Unit price", expression: "[Sales] / [Quantity]" },
    ]);
    const preview = await previewPipeline(id, { stepIndex: 1, limit: 1000 });
    expect(preview.beforeColumns).not.toContain("Unit price"); expect(preview.afterColumns).toContain("Unit price");
    expect(preview.after[0]).toMatchObject({ "Customer Name": "ALICE", "Unit price": 10 });
    expect(preview.lineage.find((line) => line.column === "Unit price")?.sources.map((source) => source.column)).toEqual(["Sales", "Quantity"]);
    const output = await executePreparedDataset(id);
    expect(output.version).toBe(saved.version); expect(output.summary.rowsOut).toBe(3);
    const csv = await readFile(output.filePath, "utf8"); expect(csv).toContain("Unit price\n"); expect(csv).not.toContain("\r");
    expect(readColumnProfiles(id).map((column) => column.name)).toEqual(preview.afterColumns);
    expect(readPipeline(id)).toMatchObject({ status: "succeeded", profiledVersion: saved.version });
    expect((await ensurePreparedDataset(id)).columns).toEqual(preview.afterColumns);
  });
  it("previews no more than its source sample, including a passthrough with no steps", async () => {
    const id = await project("Name,Sales\n" + Array.from({ length: 1200 }, (_, index) => `N${index},${index}`).join("\n") + "\n");
    const preview = await previewPipeline(id, { stepIndex: -1 });
    expect(preview.before).toHaveLength(1000); expect(preview.after).toHaveLength(1000); expect(preview.summary.rowsRead).toBe(1000);
    await expect(previewPipeline(id, { limit: 1001, stepIndex: -1 })).rejects.toMatchObject({ status: 400 });
    const controller = new AbortController(); controller.abort();
    await expect(previewPipeline(id, { stepIndex: -1 }, controller.signal)).rejects.toHaveProperty("name", "AbortError");
  });
  it("retains explicit numeric-text and whole-decimal conversions through renames, ahead of stale overrides", async () => {
    const id = await project("Code,Amount,Sales\n00123,1,10\n00099,1,20\n00123,1,10\n");
    updateColumnOverrides(id, [{ ordinal: 0, type: "integer" }, { ordinal: 1, type: "integer" }]);
    await edited(id, [
      { id: "types", type: "changeType", columns: [{ column: "Code", type: "text" }, { column: "Amount", type: "decimal" }] },
      { id: "rename", type: "select", columns: [{ name: "Code", rename: "Customer code" }, { name: "Amount" }, { name: "Sales" }] },
    ]);
    const output = await executePreparedDataset(id);
    expect(await readFile(output.filePath, "utf8")).toContain("00123,1,10");
    const columns = readColumnProfiles(id);
    expect(columns[0]).toMatchObject({ name: "Customer code", inferredType: "text", overrideType: null, minValue: "00099", maxValue: "00123" });
    expect(columns[1]).toMatchObject({ name: "Amount", inferredType: "decimal", overrideType: null });
  });
  it("cancels streaming preparation and profiling without leaving file handles or publishing partial output", async () => {
    const id = await project("Order ID,Sales\n" + Array.from({ length: 10_001 }, (_, index) => `O${index},${index % 10}`).join("\n") + "\n");
    await ensureDefaultPipeline(id);
    const controller = new AbortController();
    await expect(executePreparedDataset(id, { signal: controller.signal, onProgress: (summary) => { if (summary.rowsRead >= 5_000) controller.abort(); } })).rejects.toMatchObject({ status: 499 });
    expect(readPipeline(id)?.status).toBe("cancelled"); expect(findProject(id)?.rowCount).toBe(10_001);
    const second = new AbortController();
    await expect(profileFile(join(directory, "uploads", id, "orders.csv"), "CSV", { signal: second.signal, onProgress: () => second.abort() })).rejects.toHaveProperty("name", "AbortError");
  });
  it("lets only the newest version publish when a running profile is superseded", async () => {
    const id = await project("Order ID,Sales\n" + Array.from({ length: 6_000 }, (_, index) => `O${index},${index % 10}`).join("\n") + "\n");
    await edited(id, [{ id: "old", type: "derive", column: "Old result", expression: "[Sales] * 2" }]);
    let enter!: () => void, release!: () => void, paused = false;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const earlier = executePreparedDataset(id, { onProgress: async (summary) => { if (!paused && summary.rowsRead >= 5_000) { paused = true; enter(); await gate; } } });
    await entered;
    const latest = await edited(id, [{ id: "latest", type: "derive", column: "Latest result", expression: "[Sales] * 3" }]);
    await queuePreparedProfile(id); release();
    await expect(earlier).rejects.toMatchObject({ status: 499 });
    await waitForPreparation(id);
    expect(readPipeline(id)).toMatchObject({ status: "succeeded", version: latest.version, profiledVersion: latest.version });
    expect(readColumnProfiles(id).map((column) => column.name)).toEqual(["Order ID", "Sales", "Latest result"]);
  });
  it("recovers interrupted queued workers while retaining a live owning process", async () => {
    const id = await project(), saved = await ensureDefaultPipeline(id);
    getDatabase().prepare("UPDATE project_pipelines SET status = 'queued', updated_at = ? WHERE project_id = ?").run("2000-01-01T00:00:00.000Z", id);
    expect(await preparationStatus(id)).toMatchObject({ status: "failed", error: expect.stringContaining("interrupted") });
    expect(readPipeline(id)?.version).toBe(saved.version);
    const runId = randomUUID();
    getDatabase().prepare("INSERT INTO pipeline_quality_runs (id, project_id, pipeline_version, status, started_at, owner_pid) VALUES (?, ?, ?, ?, ?, ?)").run(runId, id, saved.version, "running", new Date().toISOString(), process.pid);
    getDatabase().prepare("UPDATE project_pipelines SET status = 'running', quality_run_id = ? WHERE project_id = ?").run(runId, id);
    expect(await preparationStatus(id)).toMatchObject({ status: "running" });
  });
  it("stores quality counts and the first 100 original rejects, and streams their complete CSV", async () => {
    const id = await project("Order ID,Sales\n" + Array.from({ length: 125 }, (_, index) => `O${index},`).join("\n") + "\n");
    await edited(id, [{ id: "quality", type: "quality", rules: [{ id: "sales-required", name: "Sales required", column: "Sales", kind: "notNull", severity: "reject" }] }]);
    const output = await executePreparedDataset(id);
    expect(output.summary.rowsRejected).toBe(125); expect(output.summary.rowsOut).toBe(0);
    const quality = readQuality(id); expect(quality.rejects).toHaveLength(100); expect(quality.run?.rejectedCount).toBe(125);
    expect(quality.rejects[0]).toMatchObject({ ruleName: "Sales required", rowNumber: 1, values: { "Order ID": "O0", Sales: null } });
    const csv = await (await preparationRejectsResponse(id, output.qualityRunId)).text();
    expect(csv).toContain("O124"); expect(csv.split("\n")).toHaveLength(127);
    expect(findProject(id)?.rowCount).toBe(0); expect(readColumnProfiles(id).every((column) => !column.isKeyCandidate)).toBe(true);
  });
  it("never publishes failed quality thresholds and reports warn-only rules separately", async () => {
    const id = await project("Order ID,Sales\nA,10\nB,\nC,\n");
    await edited(id, [{ id: "quality", type: "quality", rules: [{ id: "fail", name: "At most 10% missing", column: "Sales", kind: "notNull", severity: "fail", thresholdPct: 10 }] }]);
    await expect(executePreparedDataset(id)).rejects.toMatchObject({ status: 422 });
    expect(findProject(id)?.rowCount).toBe(3); expect(readPipeline(id)?.status).toBe("failed");
    const failed = readQuality(id); expect(failed.run?.status).toBe("failed"); expect(failed.summary?.rules[0].failed).toBe(2); expect(failed.rejects).toHaveLength(2);
    await expect(requirePreparedProfile(id)).rejects.toMatchObject({ status: 409 });
    await edited(id, [{ id: "quality", type: "quality", rules: [{ id: "warn", name: "Sales completeness", column: "Sales", kind: "notNull", severity: "warn" }] }]);
    const output = await executePreparedDataset(id); expect(output.summary.rowsOut).toBe(3); expect(output.summary.rowsRejected).toBe(0); expect(output.summary.rules[0].failed).toBe(2);
  });
  it("preserves edited model tables, names and aggregations by source name, with named errors for removed columns", async () => {
    const id = await project();
    const initial = await getOrCreateModel(id);
    initial.model.fact.name = "fact_curated"; initial.model.fact.grain = "One line per order";
    const sales = initial.model.fact.measures.find((measure) => initial.model.columnNames[measure.columnId] === "Sales")!;
    sales.name = "Revenue"; sales.aggregation = "AVG";
    saveEditedModel(id, initial.model);
    await edited(id, [{ id: "select", type: "select", columns: [{ name: "Sales" }, { name: "Order ID" }, { name: "Quantity" }] }]);
    await executePreparedDataset(id);
    const retained = readSavedModel(id)!;
    expect(retained.model.fact).toMatchObject({ name: "fact_curated", grain: "One line per order" });
    expect(retained.model.fact.measures.find((measure) => measure.name === "Revenue")).toMatchObject({ columnId: "0", aggregation: "AVG" });
    expect(retained.validation.some((issue) => issue.code === "unknown-column" && issue.message.includes("Customer Name"))).toBe(true);
    expect(retained.source).toBe("edited");
    expect(() => saveEditedModel(id, retained.model)).not.toThrow();
    const current = readColumnProfiles(id).map((column) => ({ id: String(column.ordinal), name: column.name }));
    const repaired = removeMissingPreparedAssignments(retained.model, current.map((column) => column.id));
    expect(validateModel(repaired, current).some((issue) => issue.code === "unknown-column")).toBe(false);
    expect(repaired.fact).toMatchObject({ name: "fact_curated", grain: "One line per order" });
    expect(repaired.fact.measures.find((measure) => measure.name === "Revenue")).toMatchObject({ columnId: "0", aggregation: "AVG" });
    expect(retained.validation.some((issue) => issue.code === "unknown-column")).toBe(true);
    saveEditedModel(id, repaired);
    expect(readSavedModel(id)?.validation.some((issue) => issue.code === "unknown-column")).toBe(false);
  });
  it("persists preparation summaries on an existing load without changing its compiled profile", async () => {
    const id = await project(), saved = await ensureDefaultPipeline(id), runId = randomUUID();
    getDatabase().prepare("INSERT INTO runs (id, project_id, status, mode, started_at, options_json) VALUES (?, ?, ?, ?, ?, ?)").run(runId, id, "queued", "full", new Date().toISOString(), '{}');
    const before = readColumnProfiles(id);
    const output = await executePreparedDataset(id, { runId, expectedVersion: saved.version });
    expect(readColumnProfiles(id)).toEqual(before);
    expect(JSON.parse(String(getDatabase().prepare("SELECT prepare_summary FROM runs WHERE id = ?").get(runId)?.prepare_summary)).rowsOut).toBe(3);
    expect(readQuality(id, runId).run?.id).toBe(output.qualityRunId);
    await expect(executePreparedDataset(id, { runId, expectedVersion: saved.version + 1 })).rejects.toMatchObject({ status: 409 });
  });
  it("serves the strict pipeline/quality APIs without SQL Server or arbitrary code fields", async () => {
    const id = await project();
    const first = await GET(new Request("http://localhost"), context(id)); expect(first.status).toBe(200);
    const saved = await first.json();
    const invalid = await PUT(request({ version: saved.version, definition: saved.definition, sql: "SELECT 1" }, "PUT"), context(id)); expect(invalid.status).toBe(400);
    const badPreview = await previewPOST(request({ stepIndex: -1, limit: 1001 }), context(id)); expect(badPreview.status).toBe(400);
    const preview = await previewPOST(request({ stepIndex: -1 }), context(id)); expect(preview.status).toBe(200);
    expect((await preview.json()).after).toHaveLength(3);
    const quality = await qualityGET(new Request("http://localhost"), context(id)); expect(await quality.json()).toMatchObject({ summary: null, rejects: [], runs: [] });
    const other = await project(); await executePreparedDataset(id);
    await expect(preparationRejectsResponse(other, listPreparationRuns(id)[0].id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("Superstore prepared profile integration", () => {
  it("prepares 2,003 raw rows into 2,000 profiled rows with the same preview engine", async () => {
    const raw = await readFile(join(process.cwd(), "samples/superstore_sales.csv"), "utf8");
    // The checked-in sample has 2,000 unique rows. Add three repeated source
    // records to the isolated import rather than changing shared semantic fixtures.
    const repeated = raw.trimEnd().split("\n").slice(1, 4).join("\n");
    const id = await project(`${raw.trimEnd()}\n${repeated}\n`), saved = await ensureDefaultPipeline(id);
    const definition = pipelineDefinitionSchema.parse({ ...saved.definition, steps: [
      { id: "trim", type: "cleanText", columns: ["Customer Name"], operations: ["trim"] },
      { id: "margin", type: "derive", column: "Profit Margin", expression: "[Profit] / [Sales]" },
      { id: "quantity", type: "filter", mode: "drop", condition: { kind: "condition", column: "Quantity", operator: "empty" } },
      { id: "dedupe", type: "dedupe", columns: ["Order ID"], keep: "first" },
    ] });
    await savePipeline(id, { definition, version: saved.version });
    const preview = await previewPipeline(id, { stepIndex: 3 });
    expect(preview.summary.rowsRead).toBe(1000);
    const output = await executePreparedDataset(id);
    expect(output.summary.rowsRead).toBe(2003); expect(output.summary.rowsOut).toBe(2000);
    expect(findProject(id)).toMatchObject({ rowCount: 2000, columnCount: 12 });
    expect(readColumnProfiles(id).find((column) => column.name === "Profit Margin")?.inferredType).toBe("decimal");
    const prepared = await readFile(output.filePath, "utf8"); expect(prepared).toContain("Profit Margin\n");
  });
});
