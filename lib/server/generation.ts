import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import { generateSql } from "@/lib/sql";
import type { GeneratedFile, SqlColumn } from "@/lib/sql/types";
import { modelSchema } from "@/lib/modeling/schema";
import type { Model, ModelValidationIssue } from "@/lib/modeling/types";
import { validateModel } from "@/lib/modeling/validate";
import { getOrCreateModel } from "./models";
import { ensureProjectEvidence, readColumnProfiles } from "./projects";
import { HttpError } from "./http";

export const databaseNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a target database name.")
  .max(128, "Database names must be 128 characters or fewer.")
  .refine(
    (name) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(name),
    "Database names cannot contain control characters or line breaks.",
  );

export const generationOptionsSchema = z
  .object({
    incremental: z.boolean().optional(),
    dedupe: z.boolean().optional(),
    db: databaseNameSchema.optional(),
  })
  .strict();
export type GenerationRequestOptions = z.infer<typeof generationOptionsSchema>;

export interface GenerationResponse {
  files: GeneratedFile[];
  validation: ModelValidationIssue[];
  modelUpdatedAt: string;
  options: { incremental: boolean; dedupe: boolean; database: string };
  savedDedupe: boolean;
  model: Model;
}

const generationResponseSchema: z.ZodType<GenerationResponse> = z
  .object({
    files: z.array(
      z
        .object({ name: z.string(), description: z.string(), sql: z.string() })
        .strict(),
    ),
    validation: z.array(
      z
        .object({
          severity: z.enum(["error", "warning", "info"]),
          code: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
    modelUpdatedAt: z.string(),
    options: z
      .object({
        incremental: z.boolean(),
        dedupe: z.boolean(),
        database: databaseNameSchema,
      })
      .strict(),
    savedDedupe: z.boolean(),
    model: modelSchema,
  })
  .strict();

/** Query overrides affect a preview only; saving the shared model flag uses PUT /model. */
export function parseGenerationQuery(
  parameters: URLSearchParams,
): GenerationRequestOptions {
  const values: Record<string, unknown> = {};
  for (const key of parameters.keys()) {
    if (!["incremental", "dedupe", "db"].includes(key))
      throw new HttpError(
        400,
        "The generation request contains an unsupported option.",
      );
    if (parameters.getAll(key).length !== 1)
      throw new HttpError(400, "Provide each generation option only once.");
    const value = parameters.get(key)!;
    if (key === "db") values.db = value;
    else {
      if (
        value !== "true" &&
        value !== "false" &&
        value !== "1" &&
        value !== "0"
      )
        throw new HttpError(400, `${key} must be true or false.`);
      values[key] = value === "true" || value === "1";
    }
  }
  return checkedOptions(values);
}

function checkedOptions(value: unknown): GenerationRequestOptions {
  const parsed = generationOptionsSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid generation options.",
    );
  return parsed.data;
}

/** Saved drafts can outlive type overrides; reject combinations that cannot produce valid SQL. */
function generationIssues(
  model: Model,
  columns: SqlColumn[],
  incremental: boolean,
): ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    severity: ModelValidationIssue["severity"] = "error",
  ) => issues.push({ code, message, severity });
  const byId = new Map(
    columns.map((column) => [String(column.ordinal), column]),
  );
  const effectiveType = (id: string) => {
    const column = byId.get(id);
    return column?.overrideType ?? column?.inferredType;
  };
  const dimensionsById = new Map(
    model.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const keysByDimension = new Map<string, Model["fact"]["foreignKeys"]>();
  for (const key of model.fact.foreignKeys) {
    const keys = keysByDimension.get(key.dimensionId) ?? [];
    keys.push(key);
    keysByDimension.set(key.dimensionId, keys);
  }
  if (
    model.dimensions.filter((dimension) => dimension.generated === "date")
      .length > 1
  )
    add(
      "multiple-calendars",
      "Use one shared generated calendar dimension with a separate foreign key for each source date.",
    );
  for (const measure of model.fact.measures) {
    const type = effectiveType(measure.columnId);
    if (
      type !== "integer" &&
      type !== "decimal" &&
      measure.aggregation !== "COUNT"
    )
      add(
        "incompatible-measure-type",
        `${measure.name} is no longer numeric. Restore its numeric type or update the model before downloading SQL.`,
      );
  }
  for (const dimension of model.dimensions) {
    const keys = keysByDimension.get(dimension.id) ?? [];
    if (!keys.length)
      add(
        "missing-dimension-link",
        `${dimension.name} needs a foreign-key link from the fact table.`,
      );
    if (dimension.generated === "date") {
      if (!dimension.columnIds.length)
        add(
          "missing-date-source",
          `${dimension.name} needs a source date column.`,
        );
      const sourceIds = new Set(keys.map((key) => key.sourceColumnId));
      for (const id of dimension.columnIds) {
        if (effectiveType(id) !== "date")
          add(
            "incompatible-date-type",
            `${model.columnNames[id] || byId.get(id)?.name || id} is no longer a date. Update the calendar model or restore its date type.`,
          );
        if (!sourceIds.has(id))
          add(
            "missing-date-link",
            `${dimension.name} needs a DateKey link for ${model.columnNames[id] || id}.`,
          );
      }
    } else if (
      keys.some((key) => key.sourceColumnId !== dimension.businessKey)
    ) {
      add(
        "invalid-business-key-link",
        `${dimension.name}'s fact link must use its selected business key.`,
      );
    }
    if (dimension.generated !== "date" && dimension.columnIds.length + 3 > 1024)
      add(
        "dimension-column-limit",
        `${dimension.name} exceeds SQL Server's 1,024-column table limit after adding its surrogate key and audit columns.`,
      );
  }
  if (columns.length + 1 > 1024)
    add(
      "staging-column-limit",
      "SQL Server staging supports at most 1,023 source columns plus source_row_number. Reduce the uploaded column set before generating SQL.",
    );
  if (
    model.fact.measures.length +
      model.fact.degenerateDimensions.length +
      model.fact.foreignKeys.length +
      1 >
    1024
  )
    add(
      "fact-column-limit",
      "The fact table exceeds SQL Server's 1,024-column table limit.",
    );
  const conversionIds = new Set([
    ...model.fact.measures.map((column) => column.columnId),
    ...model.fact.degenerateDimensions.map((column) => column.columnId),
    ...columns
      .filter(
        (column) => (column.overrideType ?? column.inferredType) === "date",
      )
      .map((column) => String(column.ordinal)),
    ...model.fact.foreignKeys.flatMap((key) => {
      const dimension = dimensionsById.get(key.dimensionId);
      const sourceId =
        dimension?.generated === "date"
          ? key.sourceColumnId
          : dimension?.businessKey;
      return sourceId ? [sourceId] : [];
    }),
  ]);
  if (columns.length + conversionIds.size + 2 > 1024)
    add(
      "conversion-column-limit",
      "The generated validation work table exceeds SQL Server's 1,024-column limit after adding typed conversions. Reduce the source column set before generating SQL.",
    );
  if (model.fact.foreignKeys.length > 253)
    add(
      "foreign-key-limit",
      "A SQL Server fact table supports at most 253 outgoing foreign-key references. Reduce the dimension links before generating SQL.",
    );
  const persistedDate =
    model.fact.degenerateDimensions.some(
      (column) => effectiveType(column.columnId) === "date",
    ) ||
    model.fact.foreignKeys.some((key) => {
      const dimension = dimensionsById.get(key.dimensionId);
      return dimension?.generated === "date"
        ? key.sourceColumnId !== null &&
            effectiveType(key.sourceColumnId) === "date"
        : Boolean(
            dimension?.businessKey &&
            effectiveType(dimension.businessKey) === "date",
          );
    });
  if (incremental && !persistedDate)
    if (
      columns.some(
        (column) => (column.overrideType ?? column.inferredType) === "date",
      )
    ) {
      add(
        "incremental-date-unassigned",
        "Assign a source date as a calendar link, date business key, or fact identifier for incremental loads; otherwise select full refresh.",
      );
    } else {
      add(
        "incremental-without-date",
        "No source date is available for an incremental watermark. The generated fact script uses a full refresh.",
        "warning",
      );
    }
  return issues;
}

/** No SQL Server connection or execution occurs here; only local metadata is read. */
export async function getGeneration(
  projectId: string,
  options: GenerationRequestOptions | URLSearchParams = {},
  execution?: { runId: string; filePath: string },
): Promise<GenerationResponse> {
  const requested =
    options instanceof URLSearchParams
      ? parseGenerationQuery(options)
      : checkedOptions(options);
  const project = await ensureProjectEvidence(projectId);
  const saved = await getOrCreateModel(projectId);
  const columns: SqlColumn[] = readColumnProfiles(projectId).map((column) => ({
    ...column,
    maxLength: column.maxLength ?? 0,
    maxDecimalPlaces: column.maxDecimalPlaces ?? 0,
  }));
  const resolved = {
    incremental: requested.incremental ?? false,
    dedupe: requested.dedupe ?? saved.model.removeExactDuplicates,
    database: requested.db ?? "DataForge",
  };
  const validation = [
    ...validateModel(
      { ...saved.model, removeExactDuplicates: resolved.dedupe },
      columns.map((column) => ({
        id: String(column.ordinal),
        name: column.name,
      })),
    ),
    ...generationIssues(saved.model, columns, resolved.incremental),
  ];
  const files = validation.some((issue) => issue.severity === "error")
    ? []
    : generateSql({
        project,
        columns,
        model: saved.model,
        options: {
          ...resolved,
          generatedAt: `${new Date().toISOString().slice(0, 10)} UTC`,
          ...execution,
        },
      });
  return generationResponseSchema.parse({
    files,
    validation,
    modelUpdatedAt: saved.updatedAt,
    options: resolved,
    savedDedupe: saved.model.removeExactDuplicates,
    model: saved.model,
  });
}

export function generatedZip(generation: GenerationResponse): Uint8Array {
  if (
    generation.validation.some((issue) => issue.severity === "error") ||
    !generation.files.length
  )
    throw new HttpError(
      409,
      "Resolve the model's validation errors before downloading SQL.",
    );
  return zipSync(
    Object.fromEntries(
      generation.files.map((file) => [file.name, strToU8(file.sql)]),
    ),
    { level: 6 },
  );
}
