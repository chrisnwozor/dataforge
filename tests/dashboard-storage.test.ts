import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEmptyDashboard, type DashboardDocument, type SavedDashboard } from "@/lib/dashboards/schema";
import { createEmptyView } from "@/lib/explore/config";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createExploreView } from "@/lib/server/explore-views";
import { GET as list, POST as create } from "@/app/api/projects/[id]/dashboards/route";
import { GET as open, PUT as update, DELETE as remove } from "@/app/api/projects/[id]/dashboards/[dashboardId]/route";
import { POST as duplicate } from "@/app/api/projects/[id]/dashboards/[dashboardId]/duplicate/route";

let directory: string;
let projectId: string;
let otherProjectId: string;
const context = (id: string, dashboardId: string = randomUUID()) => ({ params: Promise.resolve({ id, dashboardId }) });
const request = (body?: unknown, method = "POST") => new Request("http://localhost/api/projects/p/dashboards", {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
function project(id: string) {
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO projects (id,name,source_file,source_type,status,row_count,column_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "Dashboard tests", "sales.csv", "CSV", "Ready", 2, 2, now, now);
}
function document(name = "Sales dashboard"): DashboardDocument {
  return {
    ...createEmptyDashboard(name), description: "A shared summary",
    layout: { version: 1, tiles: [{ id: "notes", type: "text", title: "Notes", subtitle: "", numberFormat: "auto", showLegend: true, x: 0, y: 0, w: 6, h: 3, content: "# Sales\n**Review** the trend." }] },
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-dashboards-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", "");
  projectId = randomUUID(); otherProjectId = randomUUID();
  project(projectId); project(otherProjectId);
});
afterEach(() => {
  closeDatabase(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
async function saved(input: DashboardDocument = document()): Promise<SavedDashboard> {
  const response = await create(request(input), context(projectId));
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json();
}

describe("project-scoped dashboard storage and APIs", () => {
  it("upgrades an existing database without replacing projects or Explore views", () => {
    const view = createExploreView(projectId, { name: "Retained view", config: createEmptyView() });
    closeDatabase();
    const legacy = new DatabaseSync(join(directory, "dataforge.db"));
    legacy.exec("DROP TABLE dashboards");
    legacy.close();
    const upgraded = getDatabase();
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("dashboards")?.name).toBe("dashboards");
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    expect(upgraded.prepare("SELECT name FROM explore_views WHERE id = ?").get(view.id)?.name).toBe("Retained view");
  });
  it("additively creates its table and persists dashboard edits without SQL Server or a secret", async () => {
    expect(await (await list(request(undefined, "GET"), context(projectId))).json()).toEqual({ dashboards: [] });
    const dashboard = await saved();
    expect(dashboard).toMatchObject({ ...document(), projectId });
    expect(dashboard.createdAt).toBe(dashboard.updatedAt);
    closeDatabase();
    expect(await (await open(request(undefined, "GET"), context(projectId, dashboard.id))).json()).toEqual(dashboard);
    const renamed = await update(request({ name: "  Quarterly sales  " }, "PUT"), context(projectId, dashboard.id));
    const value = await renamed.json();
    expect(renamed.status).toBe(200);
    expect(value).toMatchObject({ name: "Quarterly sales", layout: document().layout });
    expect(Date.parse(value.updatedAt)).toBeGreaterThan(Date.parse(dashboard.updatedAt));
    expect((await (await list(request(undefined, "GET"), context(projectId))).json()).dashboards).toHaveLength(1);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    expect((await remove(request(undefined, "DELETE"), context(projectId, dashboard.id))).status).toBe(204);
    expect((await open(request(undefined, "GET"), context(projectId, dashboard.id))).status).toBe(404);
  });

  it("keeps every member operation scoped to its project", async () => {
    const dashboard = await saved();
    expect((await open(request(undefined, "GET"), context(otherProjectId, dashboard.id))).status).toBe(404);
    expect((await update(request({ name: "Other" }, "PUT"), context(otherProjectId, dashboard.id))).status).toBe(404);
    expect((await remove(request(undefined, "DELETE"), context(otherProjectId, dashboard.id))).status).toBe(404);
    expect((await duplicate(request(), context(otherProjectId, dashboard.id))).status).toBe(404);
    expect(await (await list(request(undefined, "GET"), context(otherProjectId))).json()).toEqual({ dashboards: [] });
    expect((await open(request(undefined, "GET"), context(projectId, dashboard.id))).status).toBe(200);
  });

  it("duplicates document content with independent dashboard and tile identities", async () => {
    const original = await saved();
    const response = await duplicate(request(), context(projectId, original.id));
    const copy: SavedDashboard = await response.json();
    expect(response.status).toBe(201);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Sales dashboard copy");
    expect(copy.description).toBe(original.description);
    expect(copy.layout.tiles[0]).toMatchObject({ ...original.layout.tiles[0], id: expect.any(String) });
    expect(copy.layout.tiles[0].id).not.toBe(original.layout.tiles[0].id);
    await update(request({ name: "Edited copy" }, "PUT"), context(projectId, copy.id));
    expect(await (await open(request(undefined, "GET"), context(projectId, original.id))).json()).toEqual(original);
  });

  it("enforces optimistic autosave revisions and monotonic timestamps", async () => {
    const dashboard = await saved();
    const first = await update(request({ name: "First edit", updatedAt: dashboard.updatedAt }, "PUT"), context(projectId, dashboard.id));
    const updated: SavedDashboard = await first.json();
    expect(first.status).toBe(200);
    const stale = await update(request({ name: "Stale edit", updatedAt: dashboard.updatedAt }, "PUT"), context(projectId, dashboard.id));
    expect(stale.status).toBe(409);
    expect(await stale.text()).toMatch(/another tab/i);
    expect(await (await open(request(undefined, "GET"), context(projectId, dashboard.id))).json()).toEqual(updated);
    const next = await update(request({ description: "Latest", updatedAt: updated.updatedAt }, "PUT"), context(projectId, dashboard.id));
    expect(next.status).toBe(200);
    expect(Date.parse((await next.json()).updatedAt)).toBeGreaterThan(Date.parse(updated.updatedAt));
  });

  it("rejects invalid IDs, names, unknown fields and unsupported JSON versions", async () => {
    expect((await list(request(undefined, "GET"), context("invalid"))).status).toBe(400);
    expect((await list(request(undefined, "GET"), context(randomUUID()))).status).toBe(404);
    expect((await open(request(undefined, "GET"), context(projectId, "invalid"))).status).toBe(400);
    for (const body of [
      { ...document(), name: " " }, { ...document(), name: "x".repeat(121) },
      { ...document(), description: "x".repeat(2001) }, { ...document(), sql: "DROP TABLE projects" },
      { ...document(), layout: { ...document().layout, version: 2 } },
      { ...document(), filters: { ...document().filters, version: 2 } },
      { ...document(), settings: { ...document().settings, version: 2 } },
    ]) expect((await create(request(body), context(projectId))).status).toBe(400);
    const dashboard = await saved();
    for (const body of [{}, { updatedAt: dashboard.updatedAt }, { settings: { version: 999 } }, { sql: "SELECT 1" }])
      expect((await update(request(body, "PUT"), context(projectId, dashboard.id))).status).toBe(400);
    expect(await (await open(request(undefined, "GET"), context(projectId, dashboard.id))).json()).toEqual(dashboard);
  });

  it("validates Explore view ownership on writes but keeps deleted references readable", async () => {
    const config = { ...createEmptyView(), values: ["sales"] };
    const view = createExploreView(projectId, { name: "Sales", config });
    const foreign = createExploreView(otherProjectId, { name: "Other", config });
    const withView = (viewId: string): DashboardDocument => ({ ...document(), layout: { version: 1, tiles: [{ id: "chart", type: "chart", title: "Sales", subtitle: "", numberFormat: "auto", showLegend: true, x: 0, y: 0, w: 6, h: 4, source: { kind: "view", viewId } }] } });
    expect((await create(request(withView(foreign.id)), context(projectId))).status).toBe(400);
    expect((await create(request(withView(randomUUID())), context(projectId))).status).toBe(400);
    const dashboard = await saved(withView(view.id));
    getDatabase().prepare("DELETE FROM explore_views WHERE id = ?").run(view.id);
    const reopened = await open(request(undefined, "GET"), context(projectId, dashboard.id));
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).layout.tiles[0].source).toEqual({ kind: "view", viewId: view.id });
    // Unrelated name edits remain possible so a missing view does not trap the document.
    expect((await update(request({ name: "Repair me" }, "PUT"), context(projectId, dashboard.id))).status).toBe(200);
    expect((await update(request({ layout: withView(view.id).layout }, "PUT"), context(projectId, dashboard.id))).status).toBe(400);
  });

  it("parameterizes untrusted text and cascades with project deletion", async () => {
    const input = document("Robert'); DROP TABLE projects;--");
    input.description = "SELECT * FROM connection_settings";
    if (input.layout.tiles[0].type === "text") input.layout.tiles[0].content = "<script>alert('plain text')</script>";
    const dashboard = await saved(input);
    expect(dashboard.name).toBe(input.name);
    expect(dashboard.description).toBe(input.description);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM projects").get()?.n).toBe(2);
    getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM dashboards").get()?.n).toBe(0);
  });

  it("rejects malformed, over-limit and non-JSON request bodies", async () => {
    expect((await create(new Request("http://localhost", { method: "POST", body: "{}" }), context(projectId))).status).toBe(415);
    expect((await create(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), context(projectId))).status).toBe(400);
    expect((await create(request({ extra: "x".repeat(1024 * 1024) }), context(projectId))).status).toBe(413);
  });

  it("reports corrupted persisted JSON without replacing it", async () => {
    const dashboard = await saved();
    for (const column of ["layout", "filters", "settings"] as const) {
      // Identifiers are fixed test constants; every runtime storage query is parameterized.
      const bad = '{"version":999}';
      const statements = {
        layout: "UPDATE dashboards SET layout = ? WHERE id = ?",
        filters: "UPDATE dashboards SET filters = ? WHERE id = ?",
        settings: "UPDATE dashboards SET settings = ? WHERE id = ?",
      };
      getDatabase().prepare(statements[column]).run(bad, dashboard.id);
      const response = await open(request(undefined, "GET"), context(projectId, dashboard.id));
      expect(response.status).toBe(500);
      expect(await response.text()).toMatch(/unsupported version.*not been changed/i);
      const row = getDatabase().prepare("SELECT layout, filters, settings FROM dashboards WHERE id = ?").get(dashboard.id)!;
      expect(row[column]).toBe(bad);
      getDatabase().prepare(statements[column]).run(JSON.stringify(dashboard[column]), dashboard.id);
    }
  });
});
