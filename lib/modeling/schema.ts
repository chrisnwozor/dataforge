import { z } from "zod";
import type { Model } from "./types";

const sourceId = z.string().regex(/^\d+$/).max(12);
const identifier = z.string().max(128);
const reason = z.string().max(2_000);
const sourceIds = z.array(sourceId).max(10_000);

/** Structural validation permits unfinished drafts; semantic issues stay visible in the editor. */
export const modelSchema: z.ZodType<Model> = z
  .object({
    fact: z
      .object({
        name: identifier,
        grain: z.string().max(2_000),
        reason,
        measures: z
          .array(
            z
              .object({
                columnId: sourceId,
                name: identifier,
                aggregation: z.enum(["SUM", "AVG", "COUNT", "MIN", "MAX"]),
                additivity: z.enum(["additive", "non-additive"]),
                reason,
              })
              .strict(),
          )
          .max(10_000),
        foreignKeys: z
          .array(
            z
              .object({
                name: identifier,
                dimensionId: z.string().min(1).max(128),
                sourceColumnId: sourceId.nullable(),
                reason,
              })
              .strict(),
          )
          .max(10_000),
        degenerateDimensions: z
          .array(
            z.object({ columnId: sourceId, name: identifier, reason }).strict(),
          )
          .max(10_000),
      })
      .strict(),
    dimensions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: identifier,
            businessKey: identifier,
            columnIds: sourceIds,
            attributes: z.array(identifier).max(10_000),
            generated: z.literal("date").nullable(),
            reason,
          })
          .strict(),
      )
      .max(10_000),
    unassigned: sourceIds,
    columnNames: z
      .record(sourceId, identifier)
      .refine((value) => Object.keys(value).length <= 10_000),
    reasons: z
      .record(sourceId, reason)
      .refine((value) => Object.keys(value).length <= 10_000),
    removeExactDuplicates: z.boolean(),
    columnstore: z.boolean().default(true),
    warnings: z.array(reason).max(10_000),
  })
  .strict();
