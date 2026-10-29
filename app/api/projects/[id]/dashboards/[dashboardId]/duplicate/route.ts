import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { duplicateDashboard } from "@/lib/server/dashboards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; dashboardId: string }> };

export async function POST(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { dashboardId } = await context.params;
    return Response.json(duplicateDashboard(id, dashboardId), {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be duplicated. Try again.");
  }
}
