import { withProjectRoute } from "@/lib/auth/guards";
import { requirePreparationProject, preparationErrorResponse, type PreparationContext } from "@/lib/server/prepare-http";
import { readQuality } from "@/lib/server/prepare";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(request: Request, context: PreparationContext): Promise<Response> {
  try { return Response.json(readQuality(await requirePreparationProject(context), new URL(request.url).searchParams.get("runId") ?? undefined), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return preparationErrorResponse(error, "Quality results could not be loaded."); }
}

export const GET = withProjectRoute("editor", handleGET);
