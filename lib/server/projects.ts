import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import type {
  InferredType,
  ProfileColumn,
  ProfileResult,
} from "@/lib/profiler";
import { dataDirectory, getDatabase, withTransaction } from "./db";

export interface StoredProject {
  id: string;
  name: string;
  sourceFile: string;
  sourceType: "CSV" | "XLSX";
  status: "Ready" | "Needs review";
  rowCount: number;
  columnCount: number;
  createdAt: string;
  updatedAt: string;
}

type ProjectRow = StoredProject & Record<string, SQLOutputValue>;

export interface StoredColumnProfile extends ProfileColumn {
  overrideType: InferredType | null;
}

export interface ProfileReport {
  raggedRowCount: number;
  raggedRowExamples: { row: number; expected: number; actual: number }[];
  delimiter: string;
}

export interface ColumnOverride {
  ordinal: number;
  type: InferredType | null;
}

export const PROJECT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectUploadDirectory(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId))
    throw new Error("Invalid project ID.");
  return join(dataDirectory(), "uploads", projectId);
}

export function listProjects(): StoredProject[] {
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, name, source_file AS sourceFile, source_type AS sourceType,
      status, row_count AS rowCount, column_count AS columnCount,
      created_at AS createdAt, updated_at AS updatedAt
    FROM projects ORDER BY updated_at DESC, created_at DESC, id ASC
  `,
    )
    .all() as ProjectRow[];
  return rows.map((row) => ({ ...row }));
}

export function findProject(projectId: string): StoredProject | undefined {
  if (!PROJECT_ID_PATTERN.test(projectId)) return undefined;
  const row = getDatabase()
    .prepare(
      `
    SELECT id, name, source_file AS sourceFile, source_type AS sourceType,
      status, row_count AS rowCount, column_count AS columnCount,
      created_at AS createdAt, updated_at AS updatedAt
    FROM projects WHERE id = ?
  `,
    )
    .get(projectId) as ProjectRow | undefined;
  return row ? { ...row } : undefined;
}

interface ColumnRow extends Omit<
  StoredColumnProfile,
  "isKeyCandidate" | "sampleValues"
> {
  [key: string]: SQLOutputValue;
  isKeyCandidate: number;
  sampleValues: string;
}

export function readColumnProfiles(projectId: string): StoredColumnProfile[] {
  if (!PROJECT_ID_PATTERN.test(projectId)) return [];
  const rows = getDatabase()
    .prepare(
      `
    SELECT ordinal, name, inferred_type AS inferredType, override_type AS overrideType,
      null_pct AS nullPct, distinct_count AS distinctCount, duplicate_count AS duplicateCount,
      min_value AS minValue, max_value AS maxValue, is_key_candidate AS isKeyCandidate,
      sample_values AS sampleValues
    FROM column_profiles WHERE project_id = ? ORDER BY ordinal ASC
  `,
    )
    .all(projectId) as ColumnRow[];
  return rows.map((row) => ({
    ...row,
    isKeyCandidate: row.isKeyCandidate === 1,
    sampleValues: JSON.parse(row.sampleValues) as string[],
  }));
}

export function readProfileReport(projectId: string): ProfileReport {
  const contents = readFileSync(
    join(projectUploadDirectory(projectId), "profile-report.json"),
    "utf8",
  );
  return JSON.parse(contents) as ProfileReport;
}

export function saveProjectProfile(
  project: StoredProject,
  profile: ProfileResult,
): StoredProject {
  const database = getDatabase();
  const insertProject = database.prepare(`
    INSERT INTO projects (id, name, source_file, source_type, status, row_count,
      column_count, created_at, updated_at)
    VALUES (@id, @name, @sourceFile, @sourceType, @status, @rowCount,
      @columnCount, @createdAt, @updatedAt)
  `);
  const insertColumn = database.prepare(`
    INSERT INTO column_profiles (project_id, ordinal, name, inferred_type, override_type,
      null_pct, distinct_count, duplicate_count, min_value, max_value, is_key_candidate, sample_values)
    VALUES (@projectId, @ordinal, @name, @inferredType, NULL, @nullPct, @distinctCount,
      @duplicateCount, @minValue, @maxValue, @isKeyCandidate, @sampleValues)
  `);
  insertProject.setAllowBareNamedParameters(true);
  insertColumn.setAllowBareNamedParameters(true);
  withTransaction(database, () => {
    insertProject.run({
      id: project.id,
      name: project.name,
      sourceFile: project.sourceFile,
      sourceType: project.sourceType,
      status: project.status,
      rowCount: project.rowCount,
      columnCount: project.columnCount,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    for (const column of profile.columns) {
      insertColumn.run({
        projectId: project.id,
        ordinal: column.ordinal,
        name: column.name,
        inferredType: column.inferredType,
        nullPct: column.nullPct,
        distinctCount: column.distinctCount,
        duplicateCount: column.duplicateCount,
        minValue: column.minValue,
        maxValue: column.maxValue,
        isKeyCandidate: column.isKeyCandidate ? 1 : 0,
        sampleValues: JSON.stringify(column.sampleValues),
      });
    }
  });
  return project;
}

export class ProjectNotFoundError extends Error {}
export class InvalidColumnError extends Error {}

export function updateColumnOverrides(
  projectId: string,
  overrides: ColumnOverride[],
): StoredColumnProfile[] {
  const database = getDatabase();
  const update = database.prepare(`
    UPDATE column_profiles SET override_type = ? WHERE project_id = ? AND ordinal = ?
  `);
  withTransaction(database, () => {
    if (!findProject(projectId))
      throw new ProjectNotFoundError("Project not found.");
    const existing = new Set(
      readColumnProfiles(projectId).map((column) => column.ordinal),
    );
    for (const override of overrides) {
      if (!existing.has(override.ordinal))
        throw new InvalidColumnError(
          "A column override references an unknown column.",
        );
      update.run(override.type, projectId, override.ordinal);
    }
    database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), projectId);
  });
  return readColumnProfiles(projectId);
}
