import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { preparationStatus } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json(await preparationStatus(await requirePreparationProject(context)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "Preparation status could not be loaded."); }
}
