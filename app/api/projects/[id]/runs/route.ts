import { withProjectRoute } from "@/lib/auth/guards";
import { z } from "zod";
import { generationOptionsSchema } from "@/lib/server/generation";
import { errorResponse, HttpError } from "@/lib/server/http";
import {
  readRunBody,
  requireRunProject,
  type ProjectRunsContext,
} from "@/lib/server/run-http";
import { findActiveRun, listRuns } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startOptionsSchema = generationOptionsSchema
  .extend({
    connectionUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

async function handleGET(
  _request: Request,
  context: ProjectRunsContext,
): Promise<Response> {
  try {
    const projectId = await requireRunProject(context);
    return Response.json(
      { runs: listRuns(projectId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Run history could not be loaded. Try again.");
  }
}

async function handlePOST(
  request: Request,
  context: ProjectRunsContext,
): Promise<Response> {
  let projectId: string | undefined;
  try {
    projectId = await requireRunProject(context);
    const parsed = startOptionsSchema.safeParse(await readRunBody(request));
    if (!parsed.success)
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Invalid run options.",
      );
    const { startRun } = await import("@/lib/runner");
    const run = await startRun(projectId, parsed.data);
    return Response.json(
      { runId: run.id, run },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && projectId) {
      return Response.json(
        {
          error: error.message,
          activeRunId: findActiveRun(projectId)?.id ?? null,
        },
        { status: 409 },
      );
    }
    return errorResponse(error, "The run could not be started. Try again.");
  }
}

export const GET = withProjectRoute("editor", handleGET);
export const POST = withProjectRoute("editor", handlePOST);
