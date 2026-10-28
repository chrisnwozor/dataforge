import { errorResponse, HttpError } from "@/lib/server/http";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";
import { getDistinctValues } from "@/lib/server/semantic-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    const id = await requireModelProject(context);
    const params = new URL(request.url).searchParams;
    if (
      [...params.keys()].some(
        (key) => !["attribute", "hideUnknown"].includes(key),
      ) ||
      params.getAll("attribute").length !== 1 ||
      params.getAll("hideUnknown").length > 1
    )
      throw new HttpError(
        400,
        "Provide one attribute and an optional hideUnknown value.",
      );
    const attribute = params.get("attribute");
    if (!attribute || attribute.length > 1024)
      throw new HttpError(400, "Choose a valid attribute for distinct values.");
    const hide = params.get("hideUnknown");
    if (hide !== null && hide !== "true" && hide !== "false")
      throw new HttpError(400, "hideUnknown must be true or false.");
    return Response.json(
      await getDistinctValues(id, attribute, request.signal, hide !== "false"),
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return errorResponse(
      error,
      "Distinct values could not be loaded. Try again.",
    );
  }
}
