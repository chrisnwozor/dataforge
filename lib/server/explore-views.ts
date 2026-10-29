import { localMode, requireProjectAccess } from "@/lib/auth/context";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { viewConfigSchema, type ViewConfig } from "@/lib/explore/config";
import { getDatabase } from "./db";
import { boundedBody, HttpError } from "./http";

export interface SavedExploreView {
  id: string;
  projectId: string;
  name: string;
  config: ViewConfig;
  createdAt: string;
  updatedAt: string;
}

const nameSchema = z.string().trim().min(1).max(120);
const createSchema = z.object({ name: nameSchema, config: viewConfigSchema }).strict();
const updateSchema = z.object({ name: nameSchema.optional(), config: viewConfigSchema.optional() }).strict()
  .refine((value) => value.name !== undefined || value.config !== undefined, "Provide a name or view configuration.");
const viewIdSchema = z.string().uuid();

function read(row: Record<string, unknown>): SavedExploreView {
  try {
    return {
      id: viewIdSchema.parse(row.id),
      projectId: z.string().uuid().parse(row.projectId),
      name: nameSchema.parse(row.name),
      config: viewConfigSchema.parse(JSON.parse(String(row.config))),
      createdAt: z.string().datetime().parse(row.createdAt),
      updatedAt: z.string().datetime().parse(row.updatedAt),
    };
  } catch {
    throw new HttpError(500, "A saved Explore view is invalid or uses an unsupported version. Its data has not been changed.");
  }
}

export function validateExploreViewId(id: string): string {
  const parsed = viewIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid Explore view ID.");
  return parsed.data;
}

export function listExploreViews(projectId: string): SavedExploreView[] {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  return getDatabase().prepare("SELECT id, project_id AS projectId, name, config, created_at AS createdAt, updated_at AS updatedAt FROM explore_views WHERE project_id = ? ORDER BY updated_at DESC, id")
    .all(projectId).map(read);
}

export function getExploreView(projectId: string, id: string): SavedExploreView {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  const row = getDatabase().prepare("SELECT id, project_id AS projectId, name, config, created_at AS createdAt, updated_at AS updatedAt FROM explore_views WHERE project_id = ? AND id = ?")
    .get(projectId, validateExploreViewId(id));
  if (!row) throw new HttpError(404, "Explore view not found in this project.");
  return read(row);
}

export function createExploreView(projectId: string, input: unknown): SavedExploreView {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a view name (1–120 characters) and a valid versioned view configuration.");
  const id = randomUUID();
  const now = new Date().toISOString();
  getDatabase().prepare("INSERT INTO explore_views (id, project_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, projectId, parsed.data.name, JSON.stringify(parsed.data.config), now, now);
  return getExploreView(projectId, id);
}

export function updateExploreView(projectId: string, id: string, input: unknown): SavedExploreView {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a valid name or versioned view configuration.");
  const saved = getExploreView(projectId, id);
  getDatabase().prepare("UPDATE explore_views SET name = ?, config = ?, updated_at = ? WHERE project_id = ? AND id = ?")
    .run(parsed.data.name ?? saved.name, JSON.stringify(parsed.data.config ?? saved.config), new Date().toISOString(), projectId, id);
  return getExploreView(projectId, id);
}

export function deleteExploreView(projectId: string, id: string): void {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  getExploreView(projectId, id);
  getDatabase().prepare("DELETE FROM explore_views WHERE project_id = ? AND id = ?").run(projectId, id);
}

export async function readExploreViewBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "Send Explore views as JSON.");
  try {
    return await new Response(await boundedBody(request, 128 * 1024)).json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The Explore view is not valid JSON.");
  }
}
