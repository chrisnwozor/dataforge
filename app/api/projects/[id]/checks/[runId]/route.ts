import { recoverVerificationRuns } from "@/lib/server/verification";
import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { getVerificationRun } from "@/lib/server/verification-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
): Promise<Response> {
  try {
    const { id, runId } = await context.params;
    recoverVerificationRuns(id);
    return Response.json({ run: getVerificationRun(id, runId) });
  } catch (error) {
    return errorResponse(error, "This checks run could not be loaded.");
  }
}
export const GET = withProjectRoute("editor", handleGET);
