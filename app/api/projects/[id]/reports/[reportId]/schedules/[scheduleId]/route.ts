import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { deleteReportSchedule, getReportSchedule, readReportBody, updateReportSchedule } from "@/lib/server/reports";
import { prepareReportSchedule } from "@/lib/server/report-schedule-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string; scheduleId: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, scheduleId } = await context.params; return Response.json(getReportSchedule(id, reportId, scheduleId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report schedule could not be loaded. Try again."); }
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context); const { reportId, scheduleId } = await context.params;
    const saved = getReportSchedule(id, reportId, scheduleId);
    const value = prepareReportSchedule(id, reportId, await readReportBody(request), saved);
    return Response.json(updateReportSchedule(id, reportId, scheduleId, value), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "The report schedule could not be saved. Try again."); }
}
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, scheduleId } = await context.params; deleteReportSchedule(id, reportId, scheduleId); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report schedule could not be deleted. Try again."); }
}
