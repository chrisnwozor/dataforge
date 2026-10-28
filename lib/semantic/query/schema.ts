import { z } from "zod";
import type { SemanticQuery } from "./types";

const reference = z.string().min(1).max(256);
export const attributeRefSchema = z
  .object({ table: reference, column: reference })
  .strict();
const valueSchema = z.union([
  z.string().max(4_000),
  z.number(),
  z.boolean(),
  z.null(),
]);
export const queryFilterSchema = z
  .object({
    attribute: attributeRefSchema,
    op: z.enum([
      "eq",
      "ne",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "notIn",
      "isNull",
      "isNotNull",
    ]),
    value: valueSchema.optional(),
    values: z.array(valueSchema).max(1_000).optional(),
  })
  .strict()
  .superRefine((filter, ctx) => {
    const list = filter.op === "in" || filter.op === "notIn";
    const nullCheck = filter.op === "isNull" || filter.op === "isNotNull";
    if (list && !filter.values)
      ctx.addIssue({
        code: "custom",
        message: "IN filters require a values array.",
        path: ["values"],
      });
    if (!list && !nullCheck && filter.value === undefined)
      ctx.addIssue({
        code: "custom",
        message: "Comparison filters require a value.",
        path: ["value"],
      });
    if (
      (!list && filter.values !== undefined) ||
      ((list || nullCheck) && filter.value !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "Provide only the values required by this filter operation.",
      });
  });

export const semanticQuerySchema = z
  .object({
    measures: z.array(reference).min(1).max(32),
    rows: z.array(attributeRefSchema).max(12).default([]),
    columns: z.array(attributeRefSchema).max(4).optional(),
    filters: z.array(queryFilterSchema).max(64).default([]),
    orderBy: z
      .array(
        z
          .object({
            ref: z.union([reference, attributeRefSchema]),
            dir: z.enum(["asc", "desc"]),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    limit: z.number().int().min(1).max(50_000).default(1_000),
    topN: z
      .object({ measure: reference, n: z.number().int().min(1).max(50_000) })
      .strict()
      .optional(),
    hideUnknown: z.boolean().default(true),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.rows.length + (query.columns?.length ?? 0) > 12)
      ctx.addIssue({
        code: "custom",
        message: "Choose at most 12 grouping attributes in total.",
      });
  });

export function normalizeQuery(input: unknown): SemanticQuery {
  return semanticQuerySchema.parse(input);
}
