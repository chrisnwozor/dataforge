import { withProjectRoute } from "@/lib/auth/guards";
import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { cancelPreparedProfile } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(_request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json(await cancelPreparedProfile(await requirePreparationProject(context)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "Preparation could not be cancelled."); }
}

export const POST = withProjectRoute("editor", handlePOST);
