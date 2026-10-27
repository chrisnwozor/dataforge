import { regenerateModel } from "@/lib/server/models";
import { errorResponse, HttpError } from "@/lib/server/http";
import { ProjectNotFoundError } from "@/lib/server/projects";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    return Response.json(
      await regenerateModel(await requireModelProject(context)),
    );
  } catch (error) {
    if (error instanceof ProjectNotFoundError)
      error = new HttpError(404, error.message);
    return errorResponse(
      error,
      "The suggested model could not be regenerated. Try again.",
    );
  }
}
