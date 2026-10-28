import { boundedBody, errorResponse, HttpError } from "@/lib/server/http";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";
import { runSemanticQuery } from "@/lib/server/semantic-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new HttpError(415, "Send a semantic query as JSON.");
    let body: unknown;
    try {
      body = await new Response(await boundedBody(request, 128 * 1024)).json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "The semantic query is not valid JSON.");
    }
    return Response.json(await runSemanticQuery(id, body, request.signal), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(
      error,
      "The semantic query could not be completed. Try again.",
    );
  }
}
