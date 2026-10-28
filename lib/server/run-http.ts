import { boundedBody, HttpError, projectIdSchema } from "./http";
import { findProject } from "./projects";
import { getRun } from "./runs";

export type ProjectRunsContext = { params: Promise<{ id: string }> };
export type ProjectRunContext = {
  params: Promise<{ id: string; runId: string }>;
};

export async function requireRunProject(
  context: ProjectRunsContext,
): Promise<string> {
  const { id } = await context.params;
  if (!projectIdSchema.safeParse(id).success)
    throw new HttpError(400, "Invalid project ID.");
  if (!findProject(id)) throw new HttpError(404, "Project not found.");
  // Reading history must release locks left by an exited process as well as
  // starting a new run; otherwise a disabled Run button could never recover.
  const { recoverInterruptedRuns } = await import("@/lib/runner");
  recoverInterruptedRuns();
  return id;
}

export async function requireProjectRun(
  context: ProjectRunContext,
): Promise<{ projectId: string; runId: string }> {
  const { id, runId } = await context.params;
  await requireRunProject({ params: Promise.resolve({ id }) });
  if (!projectIdSchema.safeParse(runId).success)
    throw new HttpError(400, "Invalid run ID.");
  const run = getRun(runId);
  if (!run || run.projectId !== id) throw new HttpError(404, "Run not found.");
  return { projectId: id, runId };
}

export async function readRunBody(request: Request): Promise<unknown> {
  if (!request.body) return {};
  let text: string;
  try {
    text = await new Response(await boundedBody(request, 16 * 1024)).text();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The run request could not be read.");
  }
  // Next.js can expose a bodyless POST as an empty stream rather than null.
  if (text === "") return {};
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Send run options as JSON.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "The run request is not valid JSON.");
  }
}
