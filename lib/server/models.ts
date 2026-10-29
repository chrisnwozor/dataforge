import { basename, extname } from "node:path";
import { modelSchema } from "@/lib/modeling/schema";
import { suggestModel } from "@/lib/modeling/suggest";
import { validateModel } from "@/lib/modeling/validate";
import type { Model, ModelValidationIssue } from "@/lib/modeling/types";
import { getDatabase, withTransaction } from "./db";
import { HttpError } from "./http";
import {
  ensureProjectEvidence,
  findProject,
  readColumnProfiles,
  readProfileReport,
  ProjectNotFoundError,
} from "./projects";

export interface SavedModel {
  model: Model;
  source: "suggested" | "edited";
  updatedAt: string;
  validation: ModelValidationIssue[];
}

function sourceColumns(projectId: string) {
  return readColumnProfiles(projectId).map((column) => ({
    id: String(column.ordinal),
    name: column.name,
  }));
}

/** Check references separately from draft issues that users are allowed to save. */
function validateReferences(projectId: string, model: Model): void {
  const ids = new Set(sourceColumns(projectId).map((column) => column.id));
  const pipeline = getDatabase().prepare("SELECT missing_columns FROM project_pipelines WHERE project_id = ?").get(projectId);
  const missing = new Set(Object.keys(JSON.parse(String(pipeline?.missing_columns ?? "{}"))));
  const sourceIds = [
    ...model.fact.measures.map((measure) => measure.columnId),
    ...model.fact.degenerateDimensions.map((column) => column.columnId),
    ...model.fact.foreignKeys.flatMap((key) =>
      key.sourceColumnId === null ? [] : [key.sourceColumnId],
    ),
    ...model.dimensions.flatMap((dimension) => dimension.columnIds),
    ...model.unassigned,
    ...Object.keys(model.columnNames),
    ...Object.keys(model.reasons),
  ];
  if (sourceIds.some((id) => !ids.has(id) && !missing.has(id)))
    throw new HttpError(400, "The model references an unknown source column.");
  if ([...ids].some((id) => !Object.hasOwn(model.columnNames, id)))
    throw new HttpError(
      400,
      "The model must include a name for every source column.",
    );
  const dimensionIds = new Set(
    model.dimensions.map((dimension) => dimension.id),
  );
  if (dimensionIds.has("fact") || dimensionIds.has("unassigned"))
    throw new HttpError(
      400,
      "Dimension IDs cannot use reserved editor locations.",
    );
  if (dimensionIds.size !== model.dimensions.length)
    throw new HttpError(400, "Each dimension must have a unique ID.");
  if (model.fact.foreignKeys.some((key) => !dimensionIds.has(key.dimensionId)))
    throw new HttpError(400, "A foreign key references an unknown dimension.");
  const dimensions = new Map(
    model.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  if (
    model.fact.foreignKeys.some(
      (key) =>
        key.sourceColumnId !== null &&
        !dimensions
          .get(key.dimensionId)
          ?.columnIds.includes(key.sourceColumnId),
    )
  )
    throw new HttpError(
      400,
      "A foreign key must reference a source column in its dimension.",
    );
  for (const dimension of model.dimensions) {
    if (dimension.generated === "date") {
      if (dimension.businessKey && dimension.businessKey !== "DateKey")
        throw new HttpError(
          400,
          "The calendar dimension uses its generated DateKey business key.",
        );
    } else if (
      (dimension.businessKey &&
        !dimension.columnIds.includes(dimension.businessKey)) ||
      dimension.attributes.some((id) => !dimension.columnIds.includes(id))
    ) {
      throw new HttpError(
        400,
        "A dimension's business key and attributes must reference its own source columns.",
      );
    }
  }
}

function checkedModel(projectId: string, value: unknown): Model {
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid model JSON.",
    );
  validateReferences(projectId, parsed.data);
  return parsed.data;
}

/** Read-only: this never generates a model or replaces a saved draft. */
export function readSavedModel(projectId: string): SavedModel | undefined {
  const row = getDatabase()
    .prepare(
      "SELECT json, source, updated_at AS updatedAt FROM models WHERE project_id = ?",
    )
    .get(projectId);
  if (!row) return undefined;
  try {
    if (row.source !== "suggested" && row.source !== "edited")
      throw new Error("Invalid model source.");
    const model = checkedModel(projectId, JSON.parse(String(row.json)));
    return {
      model,
      source: row.source,
      updatedAt: String(row.updatedAt),
      validation: validateModel(model, sourceColumns(projectId)),
    };
  } catch {
    throw new HttpError(
      500,
      "The saved model is invalid. Regenerate a suggestion to replace it, or restore a database backup.",
    );
  }
}

/** Produce a fresh suggestion without changing an existing model. */
export async function createModelSuggestion(projectId: string): Promise<Model> {
  const project = await ensureProjectEvidence(projectId);
  const report = readProfileReport(projectId);
  const sourceFile = basename(project.sourceFile);
  const model = suggestModel({
    columns: readColumnProfiles(projectId).map((column) => ({
      id: String(column.ordinal),
      ordinal: column.ordinal,
      name: column.name,
      type: column.overrideType ?? column.inferredType,
      distinctCount: column.distinctCount,
      nullPct: column.nullPct,
      isKeyCandidate: column.isKeyCandidate,
      isNearKeyCandidate: column.isNearKeyCandidate,
    })),
    sampledRows: report.sampledRows ?? [],
    rowCount: project.rowCount,
    duplicateRowCount: project.duplicateRowCount ?? 0,
    topic: sourceFile.slice(0, -extname(sourceFile).length),
  });
  return checkedModel(projectId, model);
}

/** First access inserts only if absent, preserving edits from concurrent requests. */
export async function getOrCreateModel(projectId: string): Promise<SavedModel> {
  if (!findProject(projectId))
    throw new ProjectNotFoundError("Project not found.");
  const existing = readSavedModel(projectId);
  if (existing) return existing;
  const model = await createModelSuggestion(projectId);
  const updatedAt = new Date().toISOString();
  const database = getDatabase();
  withTransaction(database, () => {
    const result = database
      .prepare(
        "INSERT INTO models (project_id, json, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO NOTHING",
      )
      .run(projectId, JSON.stringify(model), "suggested", updatedAt);
    if (result.changes)
      database
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(updatedAt, projectId);
  });
  return readSavedModel(projectId)!;
}

function writeModel(
  projectId: string,
  value: unknown,
  source: SavedModel["source"],
): SavedModel {
  if (!findProject(projectId))
    throw new ProjectNotFoundError("Project not found.");
  const model = checkedModel(projectId, value);
  const updatedAt = new Date().toISOString();
  const database = getDatabase();
  withTransaction(database, () => {
    database
      .prepare(
        `
      INSERT INTO models (project_id, json, source, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, source = excluded.source, updated_at = excluded.updated_at
    `,
      )
      .run(projectId, JSON.stringify(model), source, updatedAt);
    database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(updatedAt, projectId);
  });
  return readSavedModel(projectId)!;
}

export function saveEditedModel(projectId: string, value: unknown): SavedModel {
  return writeModel(projectId, value, "edited");
}

export async function regenerateModel(projectId: string): Promise<SavedModel> {
  return writeModel(
    projectId,
    await createModelSuggestion(projectId),
    "suggested",
  );
}
