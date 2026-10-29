import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { deleteDashboard, getDashboard, readDashboardBody, updateDashboard } from "@/lib/server/dashboards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; dashboardId: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { dashboardId } = await context.params;
    return Response.json(getDashboard(id, dashboardId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be loaded. Try again.");
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { dashboardId } = await context.params;
    return Response.json(updateDashboard(id, dashboardId, await readDashboardBody(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be saved. Try again.");
  }
}

export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const { dashboardId } = await context.params;
    deleteDashboard(id, dashboardId);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be deleted. Try again.");
  }
}
