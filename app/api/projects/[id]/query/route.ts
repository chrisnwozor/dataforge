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
import { getDistinctValues, runSemanticQuery } from "@/lib/server/semantic-query";
import { distinctValuesQuerySchema, semanticQuerySchema } from "@/lib/semantic/query/schema";
import { resultToCsv } from "@/lib/explore/csv";

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
    const csv = request.headers.get("accept")?.split(",").some((value) =>
      /^text\/csv(?:\s*;|\s*$)/i.test(value.trim()) && !/;\s*q=0(?:\.0*)?(?:\s*;|\s*$)/i.test(value),
    ) ?? false;
    if (body && typeof body === "object" && "kind" in body && body.kind === "values") {
      const parsed = distinctValuesQuerySchema.safeParse(body);
      if (!parsed.success || csv) throw new HttpError(400, "Send a valid values query as JSON with an attribute, search, and a limit up to 200.");
      const priority = request.headers.get("X-DataForge-Query-Purpose") ?? "values";
      if (priority !== "values" && priority !== "prefetch") throw new HttpError(400, "Choose values or prefetch for a values request.");
      return Response.json(await getDistinctValues(id, parsed.data.attribute, request.signal, parsed.data.hideUnknown, timing, {
        search: parsed.data.search, limit: parsed.data.limit, priority, cache: parsed.data.cache, ...(parsed.data.filters ? { filters: parsed.data.filters } : {}),
      }), { headers: { "Cache-Control": "no-store" } });
    }
    if (csv) {
      // Validate before raising the export limit; exports use the same trusted compiler and driver.
      const validated = semanticQuerySchema.safeParse(body);
      if (!validated.success)
        throw new HttpError(400, "Provide a valid semantic query to export (at most 50,000 rows).");
      body = { ...validated.data, limit: 50_000 };
    }
    const priority = request.headers.get("X-DataForge-Query-Purpose") ?? "main";
    if (priority !== "main" && priority !== "totals" && priority !== "dashboard" && priority !== "report" && priority !== "reportScheduled") throw new HttpError(400, "Choose a known semantic query purpose.");
    if (body && typeof body === "object" && "report" in body && body.report === true && priority !== "report" && priority !== "reportScheduled") throw new HttpError(400, "Use the report query purpose for a report-sized result.");
    const result = await runSemanticQuery(id, body, request.signal, timing, { priority });
    if (csv) return new Response(resultToCsv(result), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dataforge-explore.csv"',
        "X-Content-Type-Options": "nosniff",
        "X-DataForge-Truncated": String(result.truncated || result.rows.length > 50_000),
        "X-DataForge-Row-Count": String(Math.min(result.rows.length, 50_000)),
      },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return queryErrorResponse(
      error,
      "The semantic query could not be completed. Try again.",
      timing,
      id,
    );
  }
}
