import { z } from "zod";
import { modelSchema } from "@/lib/modeling/schema";
import { getOrCreateModel, saveEditedModel } from "@/lib/server/models";
import { ProjectNotFoundError } from "@/lib/server/projects";
import { boundedBody, errorResponse, HttpError } from "@/lib/server/http";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveModelSchema = z.object({ model: modelSchema }).strict();

export async function GET(
  _request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    return Response.json(
      await getOrCreateModel(await requireModelProject(context)),
    );
  } catch (error) {
    if (error instanceof ProjectNotFoundError)
      error = new HttpError(404, error.message);
    return errorResponse(error, "The model could not be loaded. Try again.");
  }
}

export async function PUT(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new HttpError(415, "Send model edits as JSON.");
    let value: unknown;
    try {
      value = await new Response(
        await boundedBody(request, 16 * 1024 * 1024),
      ).json();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "The model request is not valid JSON.");
    }
    const parsed = saveModelSchema.safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? "Invalid model JSON.",
      );
    return Response.json(saveEditedModel(id, parsed.data.model));
  } catch (error) {
    if (error instanceof ProjectNotFoundError)
      error = new HttpError(404, error.message);
    return errorResponse(error, "The model could not be saved. Try again.");
  }
}
