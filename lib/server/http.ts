import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ApiErrorResponse {
  error: string;
}

export function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message } satisfies ApiErrorResponse, {
      status: error.status,
    });
  }
  return Response.json({ error: fallback } satisfies ApiErrorResponse, {
    status: 500,
  });
}

export const projectIdSchema = z.string().uuid();
export const inferredTypeSchema = z.enum([
  "integer",
  "decimal",
  "date",
  "boolean",
  "text",
]);
export const overridesSchema = z
  .object({
    overrides: z
      .array(
        z
          .object({
            ordinal: z.number().int().nonnegative(),
            type: inferredTypeSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.overrides.map((override) => override.ordinal)).size ===
      value.overrides.length,
    {
      message: "Each column can appear only once in an override request.",
    },
  );

/** Limit streamed request bodies even when Content-Length is absent or false. */
export async function boundedBody(
  request: Request,
  maxBytes: number,
  oversizeMessage = "The request body is too large.",
): Promise<ReadableStream<Uint8Array>> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new HttpError(413, oversizeMessage);
  }
  if (!request.body) throw new HttpError(400, "The request body is missing.");
  let read = 0;
  return request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        read += chunk.byteLength;
        if (read > maxBytes) throw new HttpError(413, oversizeMessage);
        controller.enqueue(chunk);
      },
    }),
  );
}
