import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { createReport, listReports, readReportBody } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: ProjectModelContext): Promise<Response> {
  try { const id = await requireModelProject(context); return Response.json({ reports: listReports(id) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "Reports could not be loaded. Try again."); }
}
export async function POST(request: Request, context: ProjectModelContext): Promise<Response> {
  try { const id = await requireModelProject(context); return Response.json(createReport(id, await readReportBody(request)), { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be saved. Try again."); }
}
