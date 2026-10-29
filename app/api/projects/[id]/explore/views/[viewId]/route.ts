import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { deleteExploreView, getExploreView, readExploreViewBody, updateExploreView } from "@/lib/server/explore-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; viewId: string }> };

async function handleGET(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { viewId } = await context.params;
    return Response.json(getExploreView(id, viewId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "The Explore view could not be loaded.");
  }
}

async function handlePUT(request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { viewId } = await context.params;
    return Response.json(updateExploreView(id, viewId, await readExploreViewBody(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The Explore view could not be saved.");
  }
}

async function handleDELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { viewId } = await context.params;
    deleteExploreView(id, viewId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "The Explore view could not be deleted.");
  }
}

export const GET = withProjectRoute("viewer", handleGET);
export const PUT = withProjectRoute("editor", handlePUT);
export const DELETE = withProjectRoute("editor", handleDELETE);
