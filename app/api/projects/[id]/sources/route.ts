import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { listSources, publicSource, uploadSources } from "@/lib/server/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: ProjectModelContext): Promise<Response> {
  try { const id = await requireModelProject(context); return Response.json({ sources: (await listSources(id)).map(publicSource) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "Sources could not be loaded. Try again."); }
}
export async function POST(request: Request, context: ProjectModelContext): Promise<Response> {
  try { const id = await requireModelProject(context); return Response.json(await uploadSources(id, request), { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "The source could not be uploaded. Try again."); }
}
