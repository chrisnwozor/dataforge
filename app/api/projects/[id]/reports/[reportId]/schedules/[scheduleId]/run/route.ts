import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { getReportSchedule, updateReportSchedule } from "@/lib/server/reports";
import { startReportRun } from "@/lib/server/report-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string; scheduleId: string }> };
async function handlePOST(_request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context); const { reportId, scheduleId } = await context.params;
    const schedule = getReportSchedule(id, reportId, scheduleId);
    const run = await startReportRun(id, reportId, { params: schedule.params, formats: schedule.formats, scheduled: true });
    updateReportSchedule(id, reportId, scheduleId, { lastRunAt: new Date().toISOString() });
    return Response.json(run, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "The scheduled report could not be started. Try again."); }
}

export const POST = withProjectRoute("admin", handlePOST);
