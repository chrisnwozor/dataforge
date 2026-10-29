import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { cancelReportRun } from "@/lib/server/report-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; reportId: string; runId: string }> };
export async function POST(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, runId } = await context.params; return Response.json(cancelReportRun(id, reportId, runId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "This report run could not be cancelled."); }
}
