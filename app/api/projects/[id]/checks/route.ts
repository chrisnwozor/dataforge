import { z } from "zod";
import { withProjectRoute } from "@/lib/auth/guards";
import { boundedBody, errorResponse, HttpError } from "@/lib/server/http";
import {
  findActiveVerificationRun,
  listVerificationRuns,
  readCheckSettings,
} from "@/lib/server/verification-storage";
import {
  startCheckRun,
  recoverVerificationRuns,
  verificationSnapshotInfo,
} from "@/lib/server/verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function handleGET(
  _request: Request,
  context: Context,
): Promise<Response> {
  try {
    const { id } = await context.params;
    recoverVerificationRuns(id);
    return Response.json({
      runs: listVerificationRuns(id),
      settings: readCheckSettings(id),
      activeRunId: findActiveVerificationRun(id)?.id ?? null,
      ...(await verificationSnapshotInfo(id)),
    });
  } catch (error) {
    return errorResponse(
      error,
      "Check history could not be loaded. Try again.",
    );
  }
}
async function handlePOST(
  request: Request,
  context: Context,
): Promise<Response> {
  try {
    // Starting checks accepts no SQL, connection settings, filesystem path or measure override.
    if (request.body) {
      const text = await new Response(
        await boundedBody(request, 16 * 1024),
      ).text();
      if (text.trim()) {
        if (
          !request.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("application/json")
        )
          throw new HttpError(
            415,
            "Send an empty JSON object to start checks.",
          );
        let input: unknown;
        try {
          input = JSON.parse(text);
        } catch {
          throw new HttpError(400, "Send valid JSON.");
        }
        if (!z.object({}).strict().safeParse(input).success)
          throw new HttpError(
            400,
            "Checks use the saved project and accept no query or SQL input.",
          );
      }
    }
    return Response.json(
      { run: await startCheckRun((await context.params).id) },
      { status: 202 },
    );
  } catch (error) {
    return errorResponse(error, "Checks could not be started. Try again.");
  }
}
export const GET = withProjectRoute("editor", handleGET);
export const POST = withProjectRoute("editor", handlePOST);
