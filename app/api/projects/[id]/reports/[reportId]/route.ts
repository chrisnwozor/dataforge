import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { deleteReport, getReport, readReportBody, updateReport } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string }> };
async function handleGET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json(getReport(id, reportId), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be loaded. Try again."); }
}
async function handlePUT(request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json(updateReport(id, reportId, await readReportBody(request)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be saved. Try again."); }
}
async function handleDELETE(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; deleteReport(id, reportId); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be deleted. Try again."); }
}

export const GET = withProjectRoute("viewer", handleGET);
export const PUT = withProjectRoute("editor", handlePUT);
export const DELETE = withProjectRoute("editor", handleDELETE);
