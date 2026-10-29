import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { requireModelProject } from "@/lib/server/model-http";
import { duplicateReport } from "@/lib/server/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; reportId: string }> };
async function handlePOST(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId } = await context.params; return Response.json(duplicateReport(id, reportId), { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The report could not be duplicated. Try again."); }
}

export const POST = withProjectRoute("editor", handlePOST);
