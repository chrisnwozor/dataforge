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
        (key) => !["attribute", "hideUnknown", "search", "limit"].includes(key),
      ) ||
      params.getAll("attribute").length !== 1 ||
      ["hideUnknown", "search", "limit"].some((key) => params.getAll(key).length > 1)
    )
      throw new HttpError(
        400,
        "Provide one attribute and optional hideUnknown, search, and limit values.",
      );
    const attribute = params.get("attribute");
    if (!attribute || attribute.length > 1024)
      throw new HttpError(400, "Choose a valid attribute for distinct values.");
    const hide = params.get("hideUnknown");
    if (hide !== null && hide !== "true" && hide !== "false")
      throw new HttpError(400, "hideUnknown must be true or false.");
    const search = params.get("search") ?? "";
    const requestedLimit = params.get("limit");
    if (search.length > 200 || (requestedLimit !== null && (!/^\d{1,3}$/.test(requestedLimit) || Number(requestedLimit) < 1 || Number(requestedLimit) > 200)))
      throw new HttpError(400, "Search is limited to 200 characters; choose a limit between 1 and 200.");
    const priority = request.headers.get("X-DataForge-Query-Purpose") ?? "values";
    if (priority !== "values" && priority !== "prefetch") throw new HttpError(400, "Choose values or prefetch for a slicer request.");
    addQueryPhase(timing, "parseMs", parseStart);
    parsed = true;
    return Response.json(
      await getDistinctValues(
        id,
        attribute,
        request.signal,
        hide !== "false",
        timing,
        { search, limit: requestedLimit === null ? 200 : Number(requestedLimit), priority },
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
