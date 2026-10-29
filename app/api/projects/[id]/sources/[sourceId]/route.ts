import { errorResponse } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { deleteSource, getSource, publicSource, updateSource } from "@/lib/server/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; sourceId: string }> };
export async function GET(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context), { sourceId } = await context.params; return Response.json(publicSource(await getSource(id, sourceId)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "This source could not be loaded."); }
}
export async function PUT(request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context), { sourceId } = await context.params; return Response.json(await updateSource(id, sourceId, request), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error, "This source could not be updated."); }
}
export async function DELETE(_request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context), { sourceId } = await context.params; await deleteSource(id, sourceId); return new Response(null, { status: 204 }); }
  catch (error) { return errorResponse(error, "This source could not be removed."); }
}
