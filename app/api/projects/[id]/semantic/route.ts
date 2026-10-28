import { errorResponse } from "@/lib/server/http";
import { getSemanticModel, saveSemanticModel } from "@/lib/server/semantic";
import {
  readSemanticBody,
  requireSemanticProject,
  type SemanticProjectContext,
} from "@/lib/server/semantic-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  context: SemanticProjectContext,
): Promise<Response> {
  try {
    return Response.json(
      await getSemanticModel(await requireSemanticProject(context)),
    );
  } catch (error) {
    return errorResponse(
      error,
      "The semantic model could not be loaded. Try again.",
    );
  }
}
export async function PUT(
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
