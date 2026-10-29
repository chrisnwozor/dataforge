import { cleanedSourceResponse } from "@/lib/server/cleaned-source";
import { errorResponse } from "@/lib/server/http";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    return await cleanedSourceResponse(await requireModelProject(context), { signal: request.signal });
  } catch (error) {
    return errorResponse(
      error,
      "The cleaned CSV could not be exported. Try again.",
    );
  }
}
