import { getGeneration, generatedZip } from "@/lib/server/generation";
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
    const generation = await getGeneration(
      await requireModelProject(context),
      new URL(request.url).searchParams,
    );
    return new Response(Uint8Array.from(generatedZip(generation)), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="dataforge-sql.zip"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      "The SQL archive could not be created. Try again.",
    );
  }
}
