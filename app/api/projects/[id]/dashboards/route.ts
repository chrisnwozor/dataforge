import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { createDashboard, listDashboards, readDashboardBody } from "@/lib/server/dashboards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ProjectModelContext): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    return Response.json({ dashboards: listDashboards(id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Dashboards could not be loaded. Try again.");
  }
}

export async function POST(request: Request, context: ProjectModelContext): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    return Response.json(createDashboard(id, await readDashboardBody(request)), {
      status: 201, headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The dashboard could not be saved. Try again.");
  }
}
