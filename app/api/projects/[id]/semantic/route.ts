import { withProjectRoute } from "@/lib/auth/guards";
import { errorResponse } from "@/lib/server/http";
import { getSemanticModel, requireSemanticReady, saveSemanticModel } from "@/lib/server/semantic";
import {
  readSemanticBody,
  requireSemanticProject,
  type SemanticProjectContext,
} from "@/lib/server/semantic-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  _request: Request,
  context: SemanticProjectContext,
): Promise<Response> {
  try {
    const id = await requireSemanticProject(context);
    const model = await getSemanticModel(id);
    const { run } = requireSemanticReady(id);
    return Response.json(model, { headers: { "Cache-Control": "no-store", "X-DataForge-Run-Id": run.id } });
  } catch (error) {
    return errorResponse(
      error,
      "The semantic model could not be loaded. Try again.",
    );
  }
}
async function handlePUT(
  request: Request,
  context: SemanticProjectContext,
): Promise<Response> {
  try {
    return Response.json(
      await saveSemanticModel(
        await requireSemanticProject(context),
        await readSemanticBody(request),
      ),
    );
  } catch (error) {
    return errorResponse(
      error,
      "The semantic model could not be saved. Try again.",
    );
  }
}

export const GET = withProjectRoute("viewer", handleGET);
export const PUT = withProjectRoute("editor", handlePUT);
