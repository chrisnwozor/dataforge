import { boundedBody, HttpError } from "./http";
export { requireModelProject as requireSemanticProject } from "./model-http";
export type { ProjectModelContext as SemanticProjectContext } from "./model-http";

export async function readSemanticBody(
  request: Request,
  allowEmpty = false,
): Promise<unknown> {
  if (!request.body) {
    if (allowEmpty) return {};
    throw new HttpError(400, "Send semantic edits as JSON.");
  }
  const text = await new Response(
    await boundedBody(request, 16 * 1024 * 1024),
  ).text();
  if (!text && allowEmpty) return {};
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Send semantic edits as JSON.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The semantic request is not valid JSON.");
  }
}
