import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { inspectSourceUpload } from "@/lib/server/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: ProjectModelContext): Promise<Response> {
  try { const id = await requireModelProject(context); return Response.json(await inspectSourceUpload(id, request), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The source file could not be inspected. Try again."); }
}
