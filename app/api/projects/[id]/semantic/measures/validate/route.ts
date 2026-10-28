import { z } from "zod";
import { compile } from "@/lib/semantic/expr";
import { errorResponse, HttpError } from "@/lib/server/http";
import { getSemanticModel } from "@/lib/server/semantic";
import {
  readSemanticBody,
  requireSemanticProject,
  type SemanticProjectContext,
} from "@/lib/server/semantic-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const expressionSchema = z
  .object({ expression: z.string().min(1).max(2_000) })
  .strict();
export async function POST(
  request: Request,
  context: SemanticProjectContext,
): Promise<Response> {
  try {
    const projectId = await requireSemanticProject(context);
    const model = await getSemanticModel(projectId);
    const parsed = expressionSchema.safeParse(await readSemanticBody(request));
    if (!parsed.success)
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ??
          "Send an expression of at most 2,000 characters.",
      );
    try {
      const result = compile(parsed.data.expression, model);
      return Response.json({
        ok: true,
        astSummary: { kind: result.ast.kind, type: result.type },
        sql: result.sql,
        params: result.params,
        dependencies: result.dependencies,
        errors: [],
      });
    } catch (error) {
      const position =
        error instanceof Error &&
        "position" in error &&
        typeof error.position === "number"
          ? error.position
          : undefined;
      return Response.json({
        ok: false,
        errors: [
          {
            message:
              error instanceof Error ? error.message : "Invalid expression.",
            ...(position === undefined ? {} : { position }),
          },
        ],
      });
    }
  } catch (error) {
    return errorResponse(
      error,
      "The measure could not be validated. Try again.",
    );
  }
}
