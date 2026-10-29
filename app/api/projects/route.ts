import { withWorkspaceRoute } from "@/lib/auth/guards";
import { listProjects, type StoredProject } from "@/lib/server/projects";
import { createProjectFromUpload } from "@/lib/server/uploads";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ProjectsResponse { projects: StoredProject[] }

async function handleGET(): Promise<Response> {
  try {
    return Response.json({ projects: listProjects() } satisfies ProjectsResponse);
  } catch (error) {
    return errorResponse(error, "Projects could not be loaded. Try again.");
  }
}

async function handlePOST(request: Request): Promise<Response> {
  try {
    const result = await createProjectFromUpload(request);
    return Response.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error, "The project could not be saved. Try again.");
  }
}

export const GET = withWorkspaceRoute("viewer", handleGET);
export const POST = withWorkspaceRoute("editor", handlePOST);
