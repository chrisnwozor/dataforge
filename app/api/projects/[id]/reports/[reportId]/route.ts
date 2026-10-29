import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { deleteReport, getReport, readReportBody, updateReport } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json(getReport(id, reportId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be loaded. Try again."); }
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json(updateReport(id, reportId, await readReportBody(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be saved. Try again."); }
}
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; deleteReport(id, reportId); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be deleted. Try again."); }
}
