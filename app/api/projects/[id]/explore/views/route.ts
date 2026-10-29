import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { createExploreView, listExploreViews, readExploreViewBody } from "@/lib/server/explore-views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(_request: Request, context: ProjectModelContext): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    return Response.json({ views: listExploreViews(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Saved Explore views could not be loaded.");
  }
}

async function handlePOST(request: Request, context: ProjectModelContext): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    return Response.json(createExploreView(id, await readExploreViewBody(request)), {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The Explore view could not be saved.");
  }
}

export const GET = withProjectRoute("viewer", handleGET);
export const POST = withProjectRoute("editor", handlePOST);
