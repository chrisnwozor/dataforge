import { errorResponse, HttpError } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { previewSource } from "@/lib/server/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; sourceId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const id = await requireModelProject(context), { sourceId } = await context.params;
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== "limit") || query.getAll("limit").length > 1) throw new HttpError(400, "Choose one preview limit, up to 1,000 rows.");
    return Response.json(await previewSource(id, sourceId, query.has("limit") ? Number(query.get("limit")) : 20, request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error, "The source preview could not be loaded."); }
}
