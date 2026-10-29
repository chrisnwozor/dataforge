import { requirePreparationProject, preparationErrorResponse, type PreparationRunContext } from "@/lib/server/prepare-http";
import { preparationRejectsResponse } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: PreparationRunContext): Promise<Response> {
  try { const projectId = await requirePreparationProject(context), { runId } = await context.params; return await preparationRejectsResponse(projectId, runId); }
  catch (error) { return preparationErrorResponse(error, "The rejects CSV could not be downloaded."); }
}
