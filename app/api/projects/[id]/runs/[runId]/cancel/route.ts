import { z } from "zod";
import { isTerminalRun } from "@/lib/runner/types";
import { errorResponse, HttpError } from "@/lib/server/http";
import {
  readRunBody,
  requireProjectRun,
  type ProjectRunContext,
} from "@/lib/server/run-http";
import { getRun } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: ProjectRunContext,
): Promise<Response> {
  try {
    const { projectId, runId } = await requireProjectRun(context);
    if (
      !z
        .object({})
        .strict()
        .safeParse(await readRunBody(request)).success
    )
      throw new HttpError(400, "Cancel requests do not accept options or SQL.");
    if (isTerminalRun(getRun(runId)!.status))
      throw new HttpError(409, "This run has already finished.");
    const { cancelRun } = await import("@/lib/runner");
    return Response.json(await cancelRun(projectId, runId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, "The run could not be cancelled. Try again.");
  }
}
