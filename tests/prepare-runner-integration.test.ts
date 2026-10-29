import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { POST as uploadProject } from "@/app/api/projects/route";
import { POST as uploadSource } from "@/app/api/projects/[id]/sources/route";
import { PUT as savePipelineApi } from "@/app/api/projects/[id]/pipeline/route";
import { PUT as replaceSourceApi } from "@/app/api/projects/[id]/sources/[sourceId]/route";
import { saveConnection } from "@/lib/server/connection";
import { closeDatabase } from "@/lib/server/db";
import { ensureDefaultPipeline, readPipeline } from "@/lib/server/prepare-storage";
import { ensurePreparedDataset, readQuality, preparationRejectsResponse } from "@/lib/server/prepare";
import { getSource } from "@/lib/server/sources";
import { readColumnProfiles } from "@/lib/server/projects";
import { getGeneration } from "@/lib/server/generation";
import { startRun, waitForRunCompletion, type RunnerDependencies } from "@/lib/runner";
import type { SqlTransport } from "@/lib/runner/sql-transport";
import type { PipelineDefinition } from "@/lib/prepare/schema";

let directory: string;
const projects: string[] = [], runs: string[] = [];
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-prepared-load-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 17).toString("base64"));
  vi.stubEnv("DATAFORGE_STAGING_WRITE_DIR", directory);
  saveConnection({ server: "driver-double", port: 1433, database: "PreparedWarehouse", user: "test", password: "not-a-real-login", encrypt: true, trustServerCertificate: true, stagingFolder: directory });
});
afterEach(async () => {
  for (const id of runs.splice(0)) await waitForRunCompletion(id);
  // Source mutation/profile jobs own file handles and SQLite writes until done.
  for (const id of projects.splice(0)) await ensurePreparedDataset(id).catch(() => {});
  closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
});

async function createProject(csv: string, name = "orders.csv"): Promise<string> {
  const body = new FormData(); body.set("name", "Prepared load integration"); body.set("file", new File([csv], name, { type: "text/csv" }));
  const response = await uploadProject(new Request("http://localhost/api/projects", { method: "POST", body }));
  expect(response.status, await response.clone().text()).toBe(201);
  const id = (await response.json()).project.id as string; projects.push(id); return id;
}
async function addSource(projectId: string, filename: string, mime: string, options: unknown = {}): Promise<string> {
  const body = new FormData(); body.set("name", filename); body.set("file", new File([readFileSync(join(process.cwd(), "samples", filename))], filename, { type: mime })); body.set("options", JSON.stringify(options));
  const response = await uploadSource(new Request("http://localhost/sources", { method: "POST", body }), context(projectId));
  expect(response.status, await response.clone().text()).toBe(201);
  const result = await response.json(); await ensurePreparedDataset(projectId); return result.sources[0].id;
}
async function changePipeline(projectId: string, definition: PipelineDefinition) {
  const response = await savePipelineApi(new Request("http://localhost/pipeline", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition, version: readPipeline(projectId)!.version }) }), context(projectId));
  expect(response.status, await response.clone().text()).toBe(200);
  return ensurePreparedDataset(projectId);
}
function driver(rows: number, onConnect?: () => Promise<void> | void) {
  const events: string[] = [], statements: string[] = [];
  const transport: SqlTransport = {
    async connect() { events.push("connect"); await onConnect?.(); },
    async batch(sql) { statements.push(sql); events.push("batch"); return { rowsAffected: [rows] }; },
    async summary() { return { rowsStaged: rows, rowsLoaded: rows, rowsRejected: 0, rejected: [] }; },
    async rollback() { events.push("rollback"); }, cancel() { events.push("cancel"); }, async close() { events.push("close"); },
  };
  const createTransport = vi.fn<RunnerDependencies["createTransport"]>(() => { events.push("create"); return transport; });
  return { createTransport, events, statements };
}

describe("prepared dataset → profiler/generator → SQL load driver integration", () => {
  it("loads the joined sample through the actual preparation/staging path before connecting", async () => {
    const id = await createProject(readFileSync(join(process.cwd(), "samples/orders.csv"), "utf8"));
    const initial = await ensureDefaultPipeline(id);
    const customerId = await addSource(id, "customers.csv", "text/csv");
    const productId = await addSource(id, "products.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { sheetName: "Products" });
    const definition = JSON.parse(readFileSync(join(process.cwd(), "samples/prepare-example.json"), "utf8")) as PipelineDefinition;
    definition.mainSourceId = initial.definition.mainSourceId;
    for (const step of definition.steps) if (step.type === "join") step.sourceId = step.sourceId === "customers" ? customerId : productId;
    const prepared = await changePipeline(id, definition);
    expect(prepared.summary).toMatchObject({ rowsRead: 19, rowsOut: 6, rowsRejected: 2 });
    expect(prepared.summary.steps.find((step) => step.type === "dedupe")?.removed).toBe(1);
    const expectedColumns = ["Order ID", "Order Date", "Customer Name", "Segment", "Region", "Product", "Category", "Sales", "Quantity", "Discount", "Profit"];
    expect(readColumnProfiles(id).map((column) => column.name)).toEqual(expectedColumns);
    expect((await getGeneration(id)).validation.filter((issue) => issue.severity === "error")).toEqual([]);
    let signalConnected!: () => void, finishConnect!: () => void;
    const connected = new Promise<void>((resolve) => { signalConnected = resolve; });
    const held = new Promise<void>((resolve) => { finishConnect = resolve; });
    const fake = driver(6, async () => {
      const csv = readFileSync(join(directory, `${id}.csv`), "utf8");
      expect(csv).not.toContain("\r");
      const records = parse(csv, { columns: true }) as Record<string, string>[];
      expect(Object.keys(records[0])).toEqual(expectedColumns);
      expect(records).toHaveLength(6);
      expect(records[0]["Customer Name"]).toBe("Alex Morgan");
      expect(Number(records[0].Sales)).toBeGreaterThan(0);
      signalConnected(); await held;
    });
    const queued = await startRun(id, {}, { createTransport: fake.createTransport }); runs.push(queued.id);
    await connected;
    const blocked = await replaceSourceApi(new Request("http://localhost/source", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Cannot mutate an active load" }) }), { params: Promise.resolve({ id, sourceId: customerId }) });
    expect(blocked.status).toBe(409);
    finishConnect();
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run).toMatchObject({ status: "succeeded", rowsLoaded: 6, prepareSummary: { rowsRead: 19, rowsOut: 6, rowsRejected: 2 } });
    expect(detail.logs.findIndex((line) => line.message.startsWith("Prepare completed:"))).toBeLessThan(detail.logs.findIndex((line) => line.message.includes("Connecting with SQL authentication")));
    expect(detail.logs.some((line) => line.message.includes("Look up customer attributes") && line.message.includes("6 out"))).toBe(true);
    expect(fake.createTransport).toHaveBeenCalledOnce();
    expect(fake.statements.some((sql) => sql.includes("DECLARE @FilePath") && sql.includes(`${id}.csv`))).toBe(true);
    const quality = readQuality(id, queued.id);
    expect(quality.rejects.map((reject) => reject.values["Order ID"]).sort()).toEqual(["O-1007", "O-1008"]);
    expect(await (await preparationRejectsResponse(id, quality.run!.id)).text()).toContain("Order Date is required");
  });

  it("re-executes quality checks on the source at load time and stops before creating any SQL driver", async () => {
    const id = await createProject("Order ID,Customer Name,Segment,Region,Sales\nA,Alice,Consumer,East,10\nB,Bob,Corporate,West,20\nC,Alice,Consumer,West,10\n");
    const saved = await ensureDefaultPipeline(id);
    const definition: PipelineDefinition = { ...saved.definition, steps: [{ id: "quality", name: "Non-negative Sales", type: "quality", enabled: true, rules: [{ id: "positive", name: "Sales must be non-negative", column: "Sales", kind: "range", min: 0, severity: "fail", thresholdPct: 0 }] }] };
    await changePipeline(id, definition);
    expect((await getGeneration(id)).files).toHaveLength(6);
    const source = await getSource(id, definition.mainSourceId);
    // A manually restored retained file must still be checked on each load.
    writeFileSync(source.filePath, "Order ID,Customer Name,Segment,Region,Sales\nA,Alice,Consumer,East,-10\nB,Bob,Corporate,West,20\nC,Alice,Consumer,West,10\n");
    const fake = driver(3);
    const queued = await startRun(id, {}, { createTransport: fake.createTransport }); runs.push(queued.id);
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run).toMatchObject({ status: "failed", errorFile: "Prepare", errorMessage: expect.stringContaining("Sales must be non-negative") });
    expect(fake.createTransport).not.toHaveBeenCalled(); expect(fake.statements).toEqual([]);
    expect(detail.run.prepareSummary?.rules[0]).toMatchObject({ checked: 3, failed: 1, severity: "fail" });
    expect(readQuality(id, queued.id).rejects[0].values.Sales).toBe("-10");
  });
});
