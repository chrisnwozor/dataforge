import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { cancelCheckRun } from "@/lib/server/verification";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
): Promise<Response> {
  try {
    const { id, runId } = await context.params;
    return Response.json({ run: await cancelCheckRun(id, runId) });
  } catch (error) {
    return errorResponse(error, "This checks run could not be cancelled.");
  }
}
export const POST = withProjectRoute("editor", handlePOST);
