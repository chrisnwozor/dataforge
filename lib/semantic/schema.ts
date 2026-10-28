import { z } from "zod";
import type {
  SemanticHierarchy,
  SemanticMeasure,
  SemanticModel,
} from "./types";

const id = z.string().min(1).max(256);
const name = z.string().trim().min(1).max(128);
const displayName = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim().length > 0);
const timestamp = z.string().datetime();
// A supported fact may contain up to 1,024 SQL columns, with five time defaults per SUM.
export const MAX_SEMANTIC_MEASURES = 8_192;
export const MAX_SEMANTIC_HIERARCHIES = 1_024;
export const semanticMeasureSchema: z.ZodType<SemanticMeasure> = z
  .object({
    id,
    name: displayName,
    expression: z.string().min(1).max(2_000),
    format: z.enum(["number", "currency", "percent", "decimals"]),
    folder: z.string().max(128),
    description: z.string().max(2_000),
    isAuto: z.boolean(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const semanticHierarchySchema: z.ZodType<SemanticHierarchy> = z
  .object({
    id,
    name: displayName,
    tableId: id,
    levels: z.array(id).min(2).max(12),
    isAuto: z.boolean(),
  })
  .strict();

export const semanticEditsSchema = z
  .object({
    measures: z.array(semanticMeasureSchema).max(MAX_SEMANTIC_MEASURES),
    hierarchies: z.array(semanticHierarchySchema).max(MAX_SEMANTIC_HIERARCHIES),
    version: z.string().max(128).optional(),
  })
  .strict();

const column = z
  .object({
    id,
    tableId: id,
    name: displayName,
    sqlName: name,
    type: z.enum(["number", "string", "boolean", "date"]),
    role: z.enum(["key", "attribute", "measure-source"]),
    sourceColumnId: z.string().optional(),
  })
  .strict();
export const semanticModelSchema: z.ZodType<SemanticModel> = z
  .object({
    projectId: z.string().uuid(),
    version: z.string().min(1).max(128),
    factTableId: id,
    tables: z.array(
      z
        .object({
          id,
          name: displayName,
          schema: name,
          sqlName: name,
          kind: z.enum(["fact", "dimension"]),
          keyColumnId: id,
          columns: z.array(column),
        })
        .strict(),
    ),
    relationships: z.array(
      z
        .object({
          id,
          fromTableId: id,
          fromColumnId: id,
          toTableId: id,
          toColumnId: id,
          cardinality: z.literal("many-to-one"),
        })
        .strict(),
    ),
    measures: z.array(semanticMeasureSchema).max(MAX_SEMANTIC_MEASURES),
    hierarchies: z.array(semanticHierarchySchema).max(MAX_SEMANTIC_HIERARCHIES),
    date: z
      .object({
        tableId: id,
        dateColumnId: id,
        keyColumnId: id,
        factColumnId: id,
      })
      .strict()
      .optional(),
  })
  .strict();
