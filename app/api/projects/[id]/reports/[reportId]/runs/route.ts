import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse, HttpError } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { listReportRuns, readReportBody } from "@/lib/server/reports";
import { reportRunInputSchema, startReportRun } from "@/lib/server/report-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; reportId: string }> };
async function handleGET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params;
    return Response.json({ runs: listReportRuns(id, reportId) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "Report history could not be loaded."); }
}
async function handlePOST(request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params;
    const parsed = reportRunInputSchema.safeParse(await readReportBody(request));
    if (!parsed.success) throw new HttpError(400, "Choose valid report parameters and PDF, Excel, or CSV formats.");
    return Response.json(await startReportRun(id, reportId, parsed.data), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "The report could not be started."); }
}

export const GET = withProjectRoute("viewer", handleGET);
export const POST = withProjectRoute("viewer", handlePOST);
