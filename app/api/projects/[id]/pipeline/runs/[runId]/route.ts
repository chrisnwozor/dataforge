import { requirePreparationProject, preparationErrorResponse, type PreparationRunContext } from "@/lib/server/prepare-http";
import { getPreparationRun, readPreparationRejects } from "@/lib/server/prepare-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: PreparationRunContext): Promise<Response> {
  try { const projectId = await requirePreparationProject(context), { runId } = await context.params;
    return Response.json({ run: getPreparationRun(projectId, runId), rejected: readPreparationRejects(projectId, runId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return preparationErrorResponse(error, "The preparation run could not be loaded."); }
}
