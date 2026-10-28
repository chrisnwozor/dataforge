import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyView } from "@/lib/explore/config";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { GET as list, POST as create } from "@/app/api/projects/[id]/explore/views/route";
import { GET as open, PUT as update, DELETE as remove } from "@/app/api/projects/[id]/explore/views/[viewId]/route";
import type { SavedExploreView } from "@/lib/server/explore-views";

let directory: string;
let projectId: string;
let otherProjectId: string;
const context = (id: string, viewId: string = randomUUID()) => ({ params: Promise.resolve({ id, viewId }) });
const request = (body?: unknown, method = "POST") => new Request("http://localhost/api/projects/p/explore/views", {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const config = () => ({ ...createEmptyView(), values: ["sales"], rows: [{ table: "date", column: "year" }] });

function project(id: string) {
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO projects (id,name,source_file,source_type,status,row_count,column_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "Explore tests", "sales.csv", "CSV", "Ready", 2, 2, now, now);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-explore-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", "");
  projectId = randomUUID();
  otherProjectId = randomUUID();
  project(projectId);
  project(otherProjectId);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
async function saved(name = "Sales by year"): Promise<SavedExploreView> {
  const response = await create(request({ name, config: config() }), context(projectId));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

describe("project-scoped saved Explore views", () => {
  it("saves, reopens, renames, edits and deletes without a SQL connection or secret", async () => {
    expect(await (await list(request(undefined, "GET"), context(projectId))).json()).toEqual({ views: [] });
    const view = await saved();
    expect(view).toMatchObject({ name: "Sales by year", projectId, config: config() });
    expect(view.createdAt).toEqual(view.updatedAt);
    closeDatabase();
    expect(await (await open(request(undefined, "GET"), context(projectId, view.id))).json()).toEqual(view);
    const renamed = await update(request({ name: "  Annual sales  " }, "PUT"), context(projectId, view.id));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Annual sales", config: config() });
    const changed = { ...config(), viz: "bar" };
    const edited = await update(request({ config: changed }, "PUT"), context(projectId, view.id));
    expect(await edited.json()).toMatchObject({ name: "Annual sales", config: changed });
    const collection = await (await list(request(undefined, "GET"), context(projectId))).json();
    expect(collection.views).toHaveLength(1);
    expect((await remove(request(undefined, "DELETE"), context(projectId, view.id))).status).toBe(204);
    expect((await open(request(undefined, "GET"), context(projectId, view.id))).status).toBe(404);
  });

  it("keeps saved-view IDs scoped to their project for every member operation", async () => {
    const view = await saved();
    expect((await open(request(undefined, "GET"), context(otherProjectId, view.id))).status).toBe(404);
    expect((await update(request({ name: "Stolen" }, "PUT"), context(otherProjectId, view.id))).status).toBe(404);
    expect((await remove(request(undefined, "DELETE"), context(otherProjectId, view.id))).status).toBe(404);
    expect(await (await list(request(undefined, "GET"), context(otherProjectId))).json()).toEqual({ views: [] });
    expect((await open(request(undefined, "GET"), context(projectId, view.id))).status).toBe(200);
  });

  it("validates identifiers, project existence, names, strict JSON and configuration versions", async () => {
    expect((await list(request(undefined, "GET"), context("invalid"))).status).toBe(400);
    expect((await list(request(undefined, "GET"), context(randomUUID()))).status).toBe(404);
    expect((await open(request(undefined, "GET"), context(projectId, "invalid"))).status).toBe(400);
    for (const body of [
      { name: "", config: config() },
      { name: " ", config: config() },
      { name: "x".repeat(121), config: config() },
      { name: "Future", config: { ...config(), version: 2 } },
      { name: "SQL", config: config(), sql: "DROP TABLE projects" },
      { name: "Bad", config: { ...config(), unknown: true } },
    ]) expect((await create(request(body), context(projectId))).status).toBe(400);
    const view = await saved();
    expect((await update(request({}, "PUT"), context(projectId, view.id))).status).toBe(400);
    expect((await update(request({ config: { ...config(), version: 9 } }, "PUT"), context(projectId, view.id))).status).toBe(400);
    expect(await (await open(request(undefined, "GET"), context(projectId, view.id))).json()).toEqual(view);
  });

  it("parameterizes user text and cascades views when their project is deleted", async () => {
    const view = await saved("Robert'); DROP TABLE projects;--");
    expect(view.name).toBe("Robert'); DROP TABLE projects;--");
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM explore_views").get()?.n).toBe(0);
  });

  it("rejects malformed or oversized bodies and unsupported content types", async () => {
    const malformed = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect((await create(malformed, context(projectId))).status).toBe(400);
    const wrongType = new Request("http://localhost", { method: "POST", body: "{}" });
    expect((await create(wrongType, context(projectId))).status).toBe(415);
    expect((await create(request({ name: "x".repeat(130 * 1024), config: config() }), context(projectId))).status).toBe(413);
  });

  it("reports corrupted stored JSON without overwriting it", async () => {
    const view = await saved();
    getDatabase().prepare("UPDATE explore_views SET config = ? WHERE id = ?").run('{"version":999}', view.id);
    const response = await open(request(undefined, "GET"), context(projectId, view.id));
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/unsupported version.*not been changed/i);
    expect(getDatabase().prepare("SELECT config FROM explore_views WHERE id = ?").get(view.id)?.config).toBe('{"version":999}');
  });
});
