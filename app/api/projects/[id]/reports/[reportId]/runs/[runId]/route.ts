import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { deleteReportRun, getReportRun } from "@/lib/server/reports";
import { readReportPreview } from "@/lib/server/report-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; reportId: string; runId: string }> };
async function handleGET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, runId } = await context.params; const run = getReportRun(id, reportId, runId);
    return Response.json({ run, ...(run.status === "succeeded" ? { preview: readReportPreview(reportId, runId) } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "This report run could not be loaded."); }
}
async function handleDELETE(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, runId } = await context.params; deleteReportRun(id, reportId, runId); return new Response(null, { status: 204 });
  } catch (error) { return errorResponse(error, "This report run could not be deleted."); }
}

export const GET = withProjectRoute("viewer", handleGET);
export const DELETE = withProjectRoute("editor", handleDELETE);
