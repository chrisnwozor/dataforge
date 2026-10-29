import { auditEvent } from "@/lib/auth/audit";
import { localMode, requireProjectAccess } from "@/lib/auth/context";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  dashboardDocumentSchema,
  dashboardFiltersSchema,
  dashboardLayoutSchema,
  dashboardSettingsSchema,
  type DashboardDocument,
  type SavedDashboard,
} from "@/lib/dashboards/schema";
import { getDatabase, withTransaction } from "./db";
import { boundedBody, HttpError } from "./http";

const name = z.string().trim().min(1).max(120);
const identity = z.string().uuid();
const timestamp = z.string().datetime();
const updateSchema = z.object({
  name: name.optional(),
  description: z.string().max(2_000).optional(),
  layout: dashboardLayoutSchema.optional(),
  filters: dashboardFiltersSchema.optional(),
  settings: dashboardSettingsSchema.optional(),
  updatedAt: timestamp.optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "updatedAt"), "Provide dashboard edits to save.");

export function validateDashboardId(id: string): string {
  const parsed = identity.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid dashboard ID.");
  return parsed.data;
}

function readDashboard(row: Record<string, unknown>): SavedDashboard {
  try {
    return {
      ...dashboardDocumentSchema.parse({
        name: row.name,
        description: row.description,
        layout: JSON.parse(String(row.layout)),
        filters: JSON.parse(String(row.filters)),
        settings: JSON.parse(String(row.settings)),
      }),
      id: identity.parse(row.id),
      projectId: identity.parse(row.projectId),
      createdAt: timestamp.parse(row.createdAt),
      updatedAt: timestamp.parse(row.updatedAt),
    };
  } catch {
    throw new HttpError(500, "A saved dashboard is invalid or uses an unsupported version. Its data has not been changed.");
  }
}

/** Referenced views must be owned by this project; deleted references remain repairable on read. */
function validateViewReferences(projectId: string, document: DashboardDocument): void {
  const statement = getDatabase().prepare("SELECT id FROM explore_views WHERE project_id = ? AND id = ?");
  for (const tile of document.layout.tiles) {
    if (tile.type === "chart" && tile.source.kind === "view" && !statement.get(projectId, tile.source.viewId))
      throw new HttpError(400, "Choose an Explore view saved in this project. A referenced view may have been deleted.");
  }
}

export function listDashboards(projectId: string): SavedDashboard[] {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  return getDatabase().prepare("SELECT id, project_id AS projectId, name, description, layout, filters, settings, created_at AS createdAt, updated_at AS updatedAt FROM dashboards WHERE project_id = ? ORDER BY updated_at DESC, id")
    .all(projectId).map(readDashboard);
}

export function getDashboard(projectId: string, dashboardId: string): SavedDashboard {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  const row = getDatabase().prepare("SELECT id, project_id AS projectId, name, description, layout, filters, settings, created_at AS createdAt, updated_at AS updatedAt FROM dashboards WHERE project_id = ? AND id = ?")
    .get(projectId, validateDashboardId(dashboardId));
  if (!row) throw new HttpError(404, "Dashboard not found in this project.");
  return readDashboard(row);
}

export function createDashboard(projectId: string, input: unknown): SavedDashboard {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const parsed = dashboardDocumentSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a dashboard name and a valid versioned layout, filters, and settings.");
  const id = randomUUID();
  const now = new Date().toISOString();
  return withTransaction(getDatabase(), () => {
    validateViewReferences(projectId, parsed.data);
    getDatabase().prepare("INSERT INTO dashboards (id, project_id, name, description, layout, filters, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, projectId, parsed.data.name, parsed.data.description, JSON.stringify(parsed.data.layout), JSON.stringify(parsed.data.filters), JSON.stringify(parsed.data.settings), now, now);
    return getDashboard(projectId, id);
  });
}

export function updateDashboard(projectId: string, dashboardId: string, input: unknown): SavedDashboard {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide valid dashboard edits and an optional saved updatedAt timestamp.");
  return withTransaction(getDatabase(), () => {
    const saved = getDashboard(projectId, dashboardId);
    if (parsed.data.updatedAt !== undefined && parsed.data.updatedAt !== saved.updatedAt)
      throw new HttpError(409, "This dashboard changed in another tab. Reload its latest version before saving your edits.");
    const document = dashboardDocumentSchema.parse({
      name: parsed.data.name ?? saved.name,
      description: parsed.data.description ?? saved.description,
      layout: parsed.data.layout ?? saved.layout,
      filters: parsed.data.filters ?? saved.filters,
      settings: parsed.data.settings ?? saved.settings,
    });
    if (parsed.data.layout) validateViewReferences(projectId, document);
    const next = new Date(Math.max(Date.now(), Date.parse(saved.updatedAt) + 1)).toISOString();
    const result = getDatabase().prepare("UPDATE dashboards SET name = ?, description = ?, layout = ?, filters = ?, settings = ?, updated_at = ? WHERE project_id = ? AND id = ? AND updated_at = ?")
      .run(document.name, document.description, JSON.stringify(document.layout), JSON.stringify(document.filters), JSON.stringify(document.settings), next, projectId, dashboardId, saved.updatedAt);
    if (!result.changes) throw new HttpError(409, "This dashboard changed in another tab. Reload its latest version before saving your edits.");
    return getDashboard(projectId, dashboardId);
  });
}

export function duplicateDashboard(projectId: string, dashboardId: string): SavedDashboard {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const saved = getDashboard(projectId, dashboardId);
  return createDashboard(projectId, {
    name: `${saved.name.slice(0, 115)} copy`, description: saved.description,
    layout: { ...saved.layout, tiles: saved.layout.tiles.map((tile) => ({ ...tile, id: randomUUID() })) },
    filters: saved.filters, settings: saved.settings,
  });
}

export function deleteDashboard(projectId: string, dashboardId: string): void {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  getDashboard(projectId, dashboardId);
  withTransaction(getDatabase(),()=>{auditEvent("dashboard.deleted","dashboard",dashboardId);getDatabase().prepare("DELETE FROM dashboards WHERE project_id = ? AND id = ?").run(projectId, dashboardId);});
}

export async function readDashboardBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "Send dashboard edits as JSON.");
  try {
    return await new Response(await boundedBody(request, 1024 * 1024)).json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The dashboard request is not valid JSON.");
  }
}
