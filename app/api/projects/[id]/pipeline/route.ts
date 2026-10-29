import { withProjectRoute } from "@/lib/auth/guards";
import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { readPipelineBody, savePipeline } from "@/lib/server/prepare-storage";
import { preparationStatus, queuePreparedProfile } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(_request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json(await preparationStatus(await requirePreparationProject(context)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "The pipeline could not be loaded."); }
}
async function handlePUT(request: Request, context: PreparationContext): Promise<Response> {
  try {
    const projectId = await requirePreparationProject(context);
    await savePipeline(projectId, await readPipelineBody(request));
    return Response.json(await queuePreparedProfile(projectId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return preparationErrorResponse(error, "The pipeline could not be saved."); }
}

export const GET = withProjectRoute("editor", handleGET);
export const PUT = withProjectRoute("editor", handlePUT);
