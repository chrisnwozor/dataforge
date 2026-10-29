import { withProjectRoute } from "@/lib/auth/guards";
import { z } from "zod";
import { errorResponse, HttpError } from "@/lib/server/http";
import {
  regenerateSemanticDefaults,
  requireSemanticReady,
} from "@/lib/server/semantic";
import {
  readSemanticBody,
  requireSemanticProject,
  type SemanticProjectContext,
} from "@/lib/server/semantic-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handlePOST(
  request: Request,
  context: SemanticProjectContext,
): Promise<Response> {
  try {
    const projectId = await requireSemanticProject(context);
    requireSemanticReady(projectId);
    if (
      !z
        .object({})
        .strict()
        .safeParse(await readSemanticBody(request, true)).success
    )
      throw new HttpError(
        400,
        "Regenerate defaults does not accept query text or options.",
      );
    return Response.json(await regenerateSemanticDefaults(projectId));
  } catch (error) {
    return errorResponse(
      error,
      "Semantic defaults could not be regenerated. Try again.",
    );
  }
}

export const POST = withProjectRoute("editor", handlePOST);
