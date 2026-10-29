import { withProjectRoute } from "@/lib/auth/guards";
import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { listPreparationRuns } from "@/lib/server/prepare-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(_request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json({ runs: listPreparationRuns(await requirePreparationProject(context)) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "Preparation history could not be loaded."); }
}

export const GET = withProjectRoute("editor", handleGET);
