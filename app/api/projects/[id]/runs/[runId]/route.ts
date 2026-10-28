import { errorResponse } from "@/lib/server/http";
import {
  requireProjectRun,
  type ProjectRunContext,
} from "@/lib/server/run-http";
import { getRunDetail } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: ProjectRunContext,
): Promise<Response> {
  try {
    const { runId } = await requireProjectRun(context);
    return Response.json(getRunDetail(runId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The run could not be loaded. Try again.");
  }
}
