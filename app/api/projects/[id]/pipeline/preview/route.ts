import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { readPipelineBody } from "@/lib/server/prepare-storage";
import { previewPipeline } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json(await previewPipeline(await requirePreparationProject(context), await readPipelineBody(request), request.signal), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "The pipeline preview could not be loaded."); }
}
