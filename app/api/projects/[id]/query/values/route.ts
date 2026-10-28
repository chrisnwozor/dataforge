import { HttpError } from "@/lib/server/http";
import {
  addQueryPhase,
  queryErrorResponse,
  startQueryTiming,
} from "@/lib/server/query-timing";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";
import { getDistinctValues } from "@/lib/server/semantic-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  const timing = startQueryTiming();
  let id = "unknown";
  let parseStart: number | undefined;
  let parsed = false;
  try {
    id = await requireModelProject(context);
    parseStart = performance.now();
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some(
        (key) => !["attribute", "hideUnknown"].includes(key),
      ) ||
      params.getAll("attribute").length !== 1 ||
      params.getAll("hideUnknown").length > 1
    )
      throw new HttpError(
        400,
        "Provide one attribute and an optional hideUnknown value.",
      );
    const attribute = params.get("attribute");
    if (!attribute || attribute.length > 1024)
      throw new HttpError(400, "Choose a valid attribute for distinct values.");
    const hide = params.get("hideUnknown");
    if (hide !== null && hide !== "true" && hide !== "false")
      throw new HttpError(400, "hideUnknown must be true or false.");
    addQueryPhase(timing, "parseMs", parseStart);
    parsed = true;
    return Response.json(
      await getDistinctValues(
        id,
        attribute,
        request.signal,
        hide !== "false",
        timing,
      ),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (parseStart !== undefined && !parsed)
      addQueryPhase(timing, "parseMs", parseStart);
    return queryErrorResponse(
      error,
      "Distinct values could not be loaded. Try again.",
      timing,
      id,
    );
  }
}
