import { boundedBody, HttpError } from "@/lib/server/http";
import {
  addQueryPhase,
  queryErrorResponse,
  startQueryTiming,
} from "@/lib/server/query-timing";
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
  const timing = startQueryTiming();
  let id = "unknown";
  try {
    id = await requireModelProject(context);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new HttpError(415, "Send a semantic query as JSON.");
    let body: unknown;
    const parseStart = performance.now();
    try {
      body = await new Response(await boundedBody(request, 128 * 1024)).json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "The semantic query is not valid JSON.");
    } finally {
      addQueryPhase(timing, "parseMs", parseStart);
    }
    return Response.json(
      await runSemanticQuery(id, body, request.signal, timing),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return queryErrorResponse(
      error,
      "The semantic query could not be completed. Try again.",
      timing,
      id,
    );
  }
}
