import {
  findProject, readColumnProfiles, readProfileReport, updateColumnOverrides,
  ProjectNotFoundError, InvalidColumnError,
  type StoredProject, type StoredColumnProfile, type ProfileReport,
} from "@/lib/server/projects";
import { errorResponse, HttpError, overridesSchema, projectIdSchema, boundedBody } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProjectContext = { params: Promise<{ id: string }> };
export interface ProjectProfileResponse {
  project: StoredProject;
  columns: StoredColumnProfile[];
  report: ProfileReport;
}
export interface OverrideProfileResponse { columns: StoredColumnProfile[] }

async function requireProject(context: ProjectContext): Promise<StoredProject> {
  const { id } = await context.params;
  const parsed = projectIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, "Invalid project ID.");
  const project = findProject(parsed.data);
  if (!project) throw new HttpError(404, "Project not found.");
  return project;
}

export async function GET(_request: Request, context: ProjectContext): Promise<Response> {
  try {
    const project = await requireProject(context);
    return Response.json({
      project,
      columns: readColumnProfiles(project.id),
      report: readProfileReport(project.id),
    } satisfies ProjectProfileResponse);
  } catch (error) {
    return errorResponse(error, "The project profile could not be loaded. Try again.");
  }
}

export async function PATCH(request: Request, context: ProjectContext): Promise<Response> {
  try {
    const project = await requireProject(context);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Send type overrides as JSON.");
    }
    let body: unknown;
    try {
      const stream = await boundedBody(request, 512 * 1024);
      body = await new Response(stream).json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "The type override request is not valid JSON.");
    }
    const parsed = overridesSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid type overrides.");
    return Response.json({ columns: updateColumnOverrides(project.id, parsed.data.overrides) } satisfies OverrideProfileResponse);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return errorResponse(new HttpError(404, error.message), "Project not found.");
    if (error instanceof InvalidColumnError) return errorResponse(new HttpError(400, error.message), "Invalid column.");
    return errorResponse(error, "Type overrides could not be saved. Try again.");
  }
}
