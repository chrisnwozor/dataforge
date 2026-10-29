import { withProjectRoute } from "@/lib/auth/guards";
import { boundedBody, errorResponse, HttpError } from "@/lib/server/http";
import { saveCheckSettings } from "@/lib/server/verification-storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new HttpError(415, "Send check settings as JSON.");
    let input: unknown;
    try {
      input = await new Response(await boundedBody(request, 16 * 1024)).json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Send valid JSON.");
    }
    return Response.json({
      settings: saveCheckSettings((await context.params).id, input),
    });
  } catch (error) {
    return errorResponse(error, "Check settings could not be saved.");
  }
}
export const PUT = withProjectRoute("editor", handlePUT);
