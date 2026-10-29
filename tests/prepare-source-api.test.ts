import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createProjectFromUpload } from "@/lib/server/uploads";
import { getSource, listSources } from "@/lib/server/sources";
import { readPipeline, savePipeline } from "@/lib/server/prepare-storage";
import { createQueuedRun } from "@/lib/server/runs";
import { GET as list, POST as upload } from "@/app/api/projects/[id]/sources/route";
import { POST as inspect } from "@/app/api/projects/[id]/sources/inspect/route";
import { GET as open, PUT as update, DELETE as remove } from "@/app/api/projects/[id]/sources/[sourceId]/route";
import { GET as preview } from "@/app/api/projects/[id]/sources/[sourceId]/preview/route";

const state = vi.hoisted(() => ({ queued: vi.fn(async () => undefined) }));
vi.mock("@/lib/server/prepare", () => ({ queuePreparedProfile: state.queued }));
let directory: string, projectId: string, otherProjectId: string;
const context = (id: string, sourceId: string = randomUUID()) => ({ params: Promise.resolve({ id, sourceId }) });
function multipart(contents: string | Uint8Array, filename = "lookup.csv", options?: unknown, method = "POST", sheets?: string[]) {
  const form = new FormData(); form.set("name", "Lookup source");
  form.set("file", new File([typeof contents === "string" ? contents : Uint8Array.from(contents)], filename, { type: filename.endsWith("xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : filename.endsWith("json") ? "application/json" : "text/csv" }));
  if (options) form.set("options", JSON.stringify(options));
  if (sheets) form.set("sheets", JSON.stringify(sheets));
  return new Request("http://localhost/sources", { method, body: form });
}
const json = (body: unknown) => new Request("http://localhost/source", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const empty = () => new Request("http://localhost/source");
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-source-api-")); vi.stubEnv("DATAFORGE_DATA_DIR", directory); state.queued.mockClear();
  projectId = (await createProjectFromUpload(multipart("Order ID,Sales\nO1,10\nO2,20\n", "orders.csv"))).project.id;
  otherProjectId = (await createProjectFromUpload(multipart("Other,Value\nA,1\n", "other.csv"))).project.id;
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("project-scoped source APIs", () => {
  it("migrates an existing source lazily without reprofiling or revealing its private file path", async () => {
    const original = getDatabase().prepare("SELECT row_count,updated_at FROM projects WHERE id = ?").get(projectId);
    const response = await list(empty(), context(projectId)); expect(response.status).toBe(200);
    const { sources } = await response.json(); expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: "csv", rowCount: 2, options: { version: 1, headerRow: 1 }, columns: [{ name: "Order ID" }, { name: "Sales" }] });
    expect(sources[0]).not.toHaveProperty("filePath"); expect(JSON.stringify(sources)).not.toContain(directory);
    const stored = await getSource(projectId, sources[0].id); expect(existsSync(stored.filePath)).toBe(true);
    expect(readPipeline(projectId)?.definition.mainSourceId).toBe(stored.id);
    expect(getDatabase().prepare("SELECT row_count,updated_at FROM projects WHERE id = ?").get(projectId)).toEqual(original);
    expect(state.queued).not.toHaveBeenCalled();
  });
  it("uploads CSV and JSON with default options, profiles metadata and queues the bumped pipeline version", async () => {
    await listSources(projectId); const before = readPipeline(projectId)!.version;
    const response = await upload(multipart("ID,Label\n1,one\n2,two\n"), context(projectId)); expect(response.status).toBe(201);
    const body = await response.json(); expect(body.sources[0]).toMatchObject({ name: "Lookup source", kind: "csv", rowCount: 2 });
    expect(readPipeline(projectId)!.version).toBe(before + 1); expect(state.queued).toHaveBeenCalledWith(projectId);
    const nested = await upload(multipart('{"data":[{"id":1,"customer":{"name":"Alex"},"tags":["a","b"],"ignored":[{"x":1}]}]}', "data.json", { jsonArrayPath: "data" }), context(projectId));
    expect(nested.status).toBe(201); const uploaded = await nested.json(); expect(uploaded.warnings[0]).toContain("Ignored array");
    const result = await preview(new Request("http://localhost/preview?limit=20"), context(projectId, uploaded.sources[0].id));
    expect((await result.json()).rows).toEqual([{ id: 1, "customer.name": "Alex", tags: "a | b" }]);
  });
  it("inspects and imports multiple XLSX sheets sharing one safely retained file", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["ID", "Name"], ["P1", "Desk"]]), "Products");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["ID", "Category"], ["P1", "Furniture"]]), "Categories");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    const inspected = await inspect(multipart(bytes, "products.xlsx"), context(projectId)); expect(inspected.status).toBe(200);
    expect(await inspected.json()).toEqual({ kind: "xlsx", sheets: ["Products", "Categories"] });
    expect(await listSources(projectId)).toHaveLength(1);
    const response = await upload(multipart(bytes, "products.xlsx", {}, "POST", ["Products", "Categories"]), context(projectId)); expect(response.status).toBe(201);
    const { sources } = await response.json(); expect(sources).toHaveLength(2); expect(sources.map((source: { options: { sheetName: string } }) => source.options.sheetName)).toEqual(["Products", "Categories"]);
    const first = await getSource(projectId, sources[0].id), second = await getSource(projectId, sources[1].id);
    expect(first.filePath).toBe(second.filePath);
    expect((await remove(empty(), context(projectId, first.id))).status).toBe(204); expect(existsSync(second.filePath)).toBe(true);
    expect((await remove(empty(), context(projectId, second.id))).status).toBe(204); expect(existsSync(second.filePath)).toBe(false);
  });
  it("renames and replaces a source without changing its ID or pipeline steps, listing affected columns", async () => {
    const added = await (await upload(multipart("ID,Label\nO1,one\nO2,two\n"), context(projectId))).json();
    const id = added.sources[0].id; const pipeline = readPipeline(projectId)!;
    const saved = await savePipeline(projectId, { version: pipeline.version, definition: { ...pipeline.definition, steps: [{ id: "customer-lookup", name: "Customer labels", enabled: true, type: "join", sourceId: id, keys: [{ left: "Order ID", right: "ID" }], kind: "left", columns: [{ source: "Label", target: "Label" }], multiple: "first" }] } });
    expect((await update(json({ name: "Customers" }), context(projectId, id))).status).toBe(200);
    const response = await update(multipart("ID,Renamed\nO1,new\n", "replacement.csv", undefined, "PUT"), context(projectId, id)); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.source.id).toBe(id); expect(result.source.name).toBe("Lookup source");
    expect(result.affectedSteps).toEqual([{ id: "customer-lookup", name: "Customer labels", missingColumns: ["Label"] }]);
    expect(readPipeline(projectId)!.definition.steps).toEqual(saved.definition.steps);
    expect((await remove(empty(), context(projectId, id))).status).toBe(409);
  });
  it("blocks main-source deletion and source mutations during a queued/running warehouse load", async () => {
    const main = (await listSources(projectId))[0]; expect((await remove(empty(), context(projectId, main.id))).status).toBe(409);
    createQueuedRun(projectId, { incremental: false, dedupe: true, db: "warehouse" }, []);
    expect((await upload(multipart("ID\n1\n"), context(projectId))).status).toBe(409);
    expect((await update(json({ name: "Changed" }), context(projectId, main.id))).status).toBe(409);
    expect((await remove(empty(), context(projectId, main.id))).status).toBe(409);
  });
  it("rejects unsafe inputs, corrupt source metadata, cross-project access and symlink files", async () => {
    const main = (await listSources(projectId))[0];
    expect((await open(empty(), context(otherProjectId, main.id))).status).toBe(404);
    expect((await upload(multipart("not permitted", "unsafe.exe"), context(projectId))).status).toBe(415);
    expect((await upload(multipart("ID\n1\n", "x.csv", { headerRow: 0 }), context(projectId))).status).toBe(400);
    expect((await upload(multipart("ID\n1\n", "x.csv", { version: 2 }), context(projectId))).status).toBe(400);
    expect((await preview(new Request("http://localhost/preview?limit=1001"), context(projectId, main.id))).status).toBe(400);
    expect((await preview(new Request("http://localhost/preview?limit=2&limit=3"), context(projectId, main.id))).status).toBe(400);
    if (process.platform !== "win32") {
      const stored = await getSource(projectId, main.id), outside = join(directory, "outside.csv");
      const fs = await import("node:fs/promises"); await fs.writeFile(outside, "Secret\nno\n"); await fs.unlink(stored.filePath); symlinkSync(outside, stored.filePath);
      expect((await preview(empty(), context(projectId, main.id))).status).toBe(422);
    }
    getDatabase().prepare("UPDATE project_sources SET options = ? WHERE id = ?").run('{"version":2}', main.id);
    expect((await list(empty(), context(projectId))).status).toBe(500);
    expect(getDatabase().prepare("SELECT options FROM project_sources WHERE id = ?").get(main.id)?.options).toBe('{"version":2}');
  });
});
