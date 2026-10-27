import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import type {
  InferredType,
  ProfileColumn,
  ProfileResult,
} from "@/lib/profiler";
import { profileFile } from "@/lib/profiler";
import { HttpError } from "./http";
import { dataDirectory, getDatabase, withTransaction } from "./db";

export interface StoredProject {
  id: string;
  name: string;
  sourceFile: string;
  sourceType: "CSV" | "XLSX";
  status: "Ready" | "Needs review";
  rowCount: number;
  columnCount: number;
  duplicateRowCount: number | null;
  totalNullCells: number | null;
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
  evidenceVersion?: 2 | 3;
  sampledRows?: (string | null)[][];
  sampledRowsTruncated?: boolean;
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
      duplicate_row_count AS duplicateRowCount, total_null_cells AS totalNullCells,
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
      duplicate_row_count AS duplicateRowCount, total_null_cells AS totalNullCells,
      created_at AS createdAt, updated_at AS updatedAt
    FROM projects WHERE id = ?
  `,
    )
    .get(projectId) as ProjectRow | undefined;
  return row ? { ...row } : undefined;
}

interface ColumnRow extends Omit<
  StoredColumnProfile,
  | "isKeyCandidate"
  | "isNearKeyCandidate"
  | "sampleValues"
  | "maxLength"
  | "maxDecimalPlaces"
> {
  [key: string]: SQLOutputValue;
  isKeyCandidate: number;
  isNearKeyCandidate: number;
  sampleValues: string;
  maxLength: number | null;
  maxDecimalPlaces: number | null;
}

export function readColumnProfiles(projectId: string): StoredColumnProfile[] {
  if (!PROJECT_ID_PATTERN.test(projectId)) return [];
  const rows = getDatabase()
    .prepare(
      `
    SELECT ordinal, name, inferred_type AS inferredType, override_type AS overrideType,
      null_pct AS nullPct, distinct_count AS distinctCount, duplicate_count AS duplicateCount,
      COALESCE(null_count, ROUND(null_pct * (SELECT row_count FROM projects WHERE id = project_id) / 100)) AS nullCount,
      min_value AS minValue, max_value AS maxValue, is_key_candidate AS isKeyCandidate,
      is_near_key_candidate AS isNearKeyCandidate,
      max_length AS maxLength, max_decimal_places AS maxDecimalPlaces,
      sample_values AS sampleValues
    FROM column_profiles WHERE project_id = ? ORDER BY ordinal ASC
  `,
    )
    .all(projectId) as ColumnRow[];
  return rows.map((row) => ({
    ...row,
    isKeyCandidate: row.isKeyCandidate === 1,
    isNearKeyCandidate: row.isNearKeyCandidate === 1,
    sampleValues: JSON.parse(row.sampleValues) as string[],
    maxLength: row.maxLength ?? undefined,
    maxDecimalPlaces: row.maxDecimalPlaces ?? undefined,
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
      column_count, duplicate_row_count, total_null_cells, created_at, updated_at)
    VALUES (@id, @name, @sourceFile, @sourceType, @status, @rowCount,
      @columnCount, @duplicateRowCount, @totalNullCells, @createdAt, @updatedAt)
  `);
  const insertColumn = database.prepare(`
    INSERT INTO column_profiles (project_id, ordinal, name, inferred_type, override_type,
      null_pct, null_count, distinct_count, duplicate_count, min_value, max_value, is_key_candidate,
      is_near_key_candidate, sample_values, max_length, max_decimal_places)
    VALUES (@projectId, @ordinal, @name, @inferredType, NULL, @nullPct, @nullCount, @distinctCount,
      @duplicateCount, @minValue, @maxValue, @isKeyCandidate, @isNearKeyCandidate, @sampleValues, @maxLength, @maxDecimalPlaces)
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
      duplicateRowCount: profile.duplicateRowCount,
      totalNullCells: profile.totalNullCells,
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
        nullCount: column.nullCount,
        distinctCount: column.distinctCount,
        duplicateCount: column.duplicateCount,
        minValue: column.minValue,
        maxValue: column.maxValue,
        isKeyCandidate: column.isKeyCandidate ? 1 : 0,
        isNearKeyCandidate: column.isNearKeyCandidate ? 1 : 0,
        sampleValues: JSON.stringify(column.sampleValues),
        maxLength: column.maxLength ?? null,
        maxDecimalPlaces: column.maxDecimalPlaces ?? null,
      });
    }
  });
  return {
    ...project,
    duplicateRowCount: profile.duplicateRowCount,
    totalNullCells: profile.totalNullCells,
  };
}

export function profileReport(profile: ProfileResult): ProfileReport {
  return {
    raggedRowCount: profile.raggedRowCount,
    raggedRowExamples: profile.raggedRowExamples,
    delimiter: profile.delimiter,
    evidenceVersion: 3,
    sampledRows: profile.sampledRows,
    sampledRowsTruncated: profile.sampledRowsTruncated,
  };
}

const evidenceBackfills = new Map<string, Promise<StoredProject>>();

/** Enrich earlier imports from their retained source without replacing edits. */
export async function ensureProjectEvidence(
  projectId: string,
): Promise<StoredProject> {
  const project = findProject(projectId);
  if (!project) throw new ProjectNotFoundError("Project not found.");
  let report: ProfileReport | undefined;
  try {
    report = readProfileReport(projectId);
  } catch {
    // A missing/legacy report can be reconstructed from the original upload.
  }
  if (
    project.duplicateRowCount !== null &&
    project.totalNullCells !== null &&
    report?.evidenceVersion === 3 &&
    Array.isArray(report.sampledRows) &&
    typeof report.sampledRowsTruncated === "boolean" &&
    !getDatabase()
      .prepare(
        "SELECT 1 FROM column_profiles WHERE project_id = ? AND (max_length IS NULL OR max_decimal_places IS NULL) LIMIT 1",
      )
      .get(projectId)
  )
    return project;
  const key = join(dataDirectory(), projectId);
  const pending = evidenceBackfills.get(key);
  if (pending) return pending;
  const backfill = (async () => {
    const directory = projectUploadDirectory(projectId);
    if (
      !project.sourceFile ||
      /[\\/:\u0000]/.test(project.sourceFile) ||
      basename(project.sourceFile) !== project.sourceFile ||
      resolve(directory, project.sourceFile) === resolve(directory)
    )
      throw new HttpError(
        422,
        "The retained source file path is invalid. Re-import this project.",
      );
    let profile: ProfileResult;
    try {
      profile = await profileFile(
        join(directory, project.sourceFile),
        project.sourceType,
      );
    } catch {
      throw new HttpError(
        422,
        "This older import needs its original source file to refresh profiling. Restore the file in data/uploads or re-import it.",
      );
    }
    const database = getDatabase();
    const updateColumn = database.prepare(`
      UPDATE column_profiles SET null_count = ?, is_key_candidate = ?, is_near_key_candidate = ?, max_length = ?, max_decimal_places = ?
      WHERE project_id = ? AND ordinal = ?
    `);
    withTransaction(database, () => {
      database
        .prepare(
          "UPDATE projects SET duplicate_row_count = ?, total_null_cells = ? WHERE id = ?",
        )
        .run(profile.duplicateRowCount, profile.totalNullCells, projectId);
      for (const column of profile.columns)
        updateColumn.run(
          column.nullCount,
          column.isKeyCandidate ? 1 : 0,
          column.isNearKeyCandidate ? 1 : 0,
          column.maxLength ?? 0,
          column.maxDecimalPlaces ?? 0,
          projectId,
          column.ordinal,
        );
    });
    const reportPath = join(directory, "profile-report.json");
    const temporaryPath = join(directory, `profile-report-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(profileReport(profile)), {
      flag: "wx",
    });
    await rename(temporaryPath, reportPath);
    return findProject(projectId)!;
  })();
  evidenceBackfills.set(key, backfill);
  try {
    return await backfill;
  } finally {
    evidenceBackfills.delete(key);
  }
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
