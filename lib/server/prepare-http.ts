import { errorResponse } from "./http";
export { requireModelProject as requirePreparationProject } from "./model-http";
export type PreparationContext = { params: Promise<{ id: string }> };
export type PreparationRunContext = { params: Promise<{ id: string; runId: string }> };
export function preparationErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof Error && error.name === "AbortError") return Response.json({ error: "Preparation cancelled." }, { status: 499 });
  return errorResponse(error, fallback);
}
