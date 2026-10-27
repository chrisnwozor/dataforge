import { findProject } from "./projects";
import { HttpError, projectIdSchema } from "./http";

export type ProjectModelContext = { params: Promise<{ id: string }> };

export async function requireModelProject(
  context: ProjectModelContext,
): Promise<string> {
  const { id } = await context.params;
  const parsed = projectIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid project ID.");
  if (!findProject(parsed.data)) throw new HttpError(404, "Project not found.");
  return parsed.data;
}
