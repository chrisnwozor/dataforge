import { withProjectRoute } from "@/lib/auth/guards";
import { getGeneration } from "@/lib/server/generation";
import { errorResponse } from "@/lib/server/http";
import {
  requireModelProject,
  type ProjectModelContext,
} from "@/lib/server/model-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(
  request: Request,
  context: ProjectModelContext,
): Promise<Response> {
  try {
    return Response.json(
      await getGeneration(
        await requireModelProject(context),
        new URL(request.url).searchParams,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "SQL could not be generated. Try again.");
  }
}

export const GET = withProjectRoute("editor", handleGET);
