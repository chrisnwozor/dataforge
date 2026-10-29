import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { createReportSchedule, listReportSchedules, readReportBody } from "@/lib/server/reports";
import { prepareReportSchedule } from "@/lib/server/report-schedule-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json({ schedules: listReportSchedules(id, reportId) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "Report schedules could not be loaded. Try again."); }
}
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context); const { reportId } = await context.params;
    const value = prepareReportSchedule(id, reportId, await readReportBody(request));
    return Response.json(createReportSchedule(id, reportId, value), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "The report schedule could not be saved. Try again."); }
}
