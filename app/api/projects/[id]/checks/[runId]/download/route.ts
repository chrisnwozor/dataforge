import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { getVerificationRun } from "@/lib/server/verification-storage";
import { checkRunCsv } from "@/lib/verify/export";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
): Promise<Response> {
  try {
    const { id, runId } = await context.params;
    const run = getVerificationRun(id, runId);
    return new Response(checkRunCsv(run), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dataforge-checks-${run.id}.csv"`,
      },
    });
  } catch (error) {
    return errorResponse(error, "The checks report could not be downloaded.");
  }
}
export const GET = withProjectRoute("editor", handleGET);
