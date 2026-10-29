import { currentWorkspaceId, requireProjectFileAccess, localMode, requireProjectAccess } from "@/lib/auth/context";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import type {
  InferredType,
  ProfileColumn,
  ProfileResult,
} from "@/lib/profiler";
import { profileFile } from "@/lib/profiler";
import { modelSchema } from "@/lib/modeling/schema";
import { reconcilePreparedModel } from "@/lib/prepare/reconcile-model";
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
  const workspaceId = requireProjectFileAccess(projectId);
  const legacy = join(dataDirectory(), "uploads", projectId);
  // Existing local files remain usable; all new authenticated uploads use tenant folders.
  if (localMode() || (workspaceId === "00000000-0000-4000-8000-000000000001" && existsSync(legacy))) return legacy;
  return join(dataDirectory(), "workspaces", workspaceId, "uploads", projectId);
}

export function projectUploadSegments(projectId: string): string[] {
  return relative(dataDirectory(), projectUploadDirectory(projectId)).split(sep);
}

/** Only server-generated UUID folders may be created; no symlink parents. */
export function createProjectUploadDirectory(projectId: string): string {
  const directory=projectUploadDirectory(projectId);
  const segments=projectUploadSegments(projectId);
  let parent=dataDirectory();
  mkdirSync(/* turbopackIgnore: true */ parent,{recursive:true});
  for(const segment of segments.slice(0,-1)){
    parent=join(/* turbopackIgnore: true */ parent,segment);
    try{mkdirSync(/* turbopackIgnore: true */ parent);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(/* turbopackIgnore: true */ parent);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new HttpError(422,"Uploads must stay in regular workspace directories.");
  }
  mkdirSync(/* turbopackIgnore: true */ directory,{mode:0o700});
  return directory;
}

export function listProjects(): StoredProject[] {
  const rows = getDatabase()
    .prepare(
      `
    SELECT id, name, source_file AS sourceFile, source_type AS sourceType,
      status, row_count AS rowCount, column_count AS columnCount,
      duplicate_row_count AS duplicateRowCount, total_null_cells AS totalNullCells,
      created_at AS createdAt, updated_at AS updatedAt
    FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC, created_at DESC, id ASC
  `,
    )
    .all(currentWorkspaceId()) as ProjectRow[];
  return rows.map((row) => ({ ...row }));
}

export function findProject(projectId: string): StoredProject | undefined {
  if (!localMode()) requireProjectAccess(projectId, "viewer");
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
  if (!localMode()) requireProjectAccess(projectId, "viewer");
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
  if (!localMode()) requireProjectAccess(projectId, "viewer");
  const prepared = getDatabase().prepare("SELECT profile_report FROM project_pipelines WHERE project_id = ?").get(projectId);
  if (prepared?.profile_report) return JSON.parse(String(prepared.profile_report)) as ProfileReport;
  const contents = readFileSync(
    join(projectUploadDirectory(projectId), "profile-report.json"),
    "utf8",
  );
  return JSON.parse(contents) as ProfileReport;
}

/** Publish one prepared generation atomically, without discarding compatible model edits. */
export function publishPreparedProfile(projectId: string, version: number, profile: ProfileResult, filePath: string, explicitTypes: ReadonlyMap<string, InferredType> = new Map()): boolean {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  const database = getDatabase();
  return withTransaction(database, () => {
    const pipeline = database.prepare("SELECT version, missing_columns FROM project_pipelines WHERE project_id = ?").get(projectId);
    if (!pipeline || Number(pipeline.version) !== version) return false;
    const existingColumns = readColumnProfiles(projectId);
    const overrides = new Map(existingColumns.map((column) => [column.name, column.overrideType]));
    const priorTypes = new Map(existingColumns.map((column) => [column.name, column.inferredType]));
    const saved = database.prepare("SELECT json FROM models WHERE project_id = ?").get(projectId);
    let missing: Record<string, string> = {};
    if (saved) {
      const parsed = modelSchema.safeParse(JSON.parse(String(saved.json)));
      if (!parsed.success) throw new HttpError(409, "The saved model cannot be reconciled. Repair its JSON before preparing a new dataset.");
      const reconciled = reconcilePreparedModel(parsed.data, existingColumns, profile.columns, JSON.parse(String(pipeline.missing_columns ?? "{}")));
      reconciled.model.warnings = reconciled.model.warnings.filter((warning) => !/\b[\d,]+\s+(?:fully\s+)?duplicat(?:e|ed)\s+rows?\b/i.test(warning));
      if (profile.duplicateRowCount) reconciled.model.warnings.push(`${profile.duplicateRowCount.toLocaleString("en-US")} duplicated rows exist. Consider removing exact duplicates.`);
      modelSchema.parse(reconciled.model);
      missing = reconciled.missing;
      database.prepare("UPDATE models SET json = ?, updated_at = ? WHERE project_id = ?").run(JSON.stringify(reconciled.model), new Date().toISOString(), projectId);
    }
    database.prepare("DELETE FROM column_profiles WHERE project_id = ?").run(projectId);
    const insert = database.prepare("INSERT INTO column_profiles (project_id, ordinal, name, inferred_type, override_type, null_pct, null_count, distinct_count, duplicate_count, min_value, max_value, is_key_candidate, is_near_key_candidate, sample_values, max_length, max_decimal_places) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const column of profile.columns) insert.run(projectId, column.ordinal, column.name, explicitTypes.get(column.name) ?? (profile.rowCount ? column.inferredType : priorTypes.get(column.name) ?? column.inferredType), explicitTypes.has(column.name) ? null : overrides.get(column.name) ?? null, column.nullPct, column.nullCount, column.distinctCount, column.duplicateCount, column.minValue, column.maxValue, column.isKeyCandidate ? 1 : 0, column.isNearKeyCandidate ? 1 : 0, JSON.stringify(column.sampleValues), column.maxLength ?? 0, column.maxDecimalPlaces ?? 0);
    database.prepare("UPDATE projects SET status = ?, row_count = ?, column_count = ?, duplicate_row_count = ?, total_null_cells = ?, updated_at = ? WHERE id = ?")
      .run(missing && Object.keys(missing).length ? "Needs review" : "Ready", profile.rowCount, profile.columnCount, profile.duplicateRowCount, profile.totalNullCells, new Date().toISOString(), projectId);
    database.prepare("UPDATE project_pipelines SET profiled_version = ?, prepared_path = ?, profile_report = ?, missing_columns = ? WHERE project_id = ? AND version = ?")
      .run(version, filePath, JSON.stringify(profileReport(profile)), JSON.stringify(missing), projectId, version);
    return true;
  });
}

export function saveProjectProfile(
  project: StoredProject,
  profile: ProfileResult,
): StoredProject {
  const database = getDatabase();
  const insertProject = database.prepare(`
    INSERT INTO projects (workspace_id, id, name, source_file, source_type, status, row_count,
      column_count, duplicate_row_count, total_null_cells, created_at, updated_at)
    VALUES (@workspaceId, @id, @name, @sourceFile, @sourceType, @status, @rowCount,
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
      workspaceId: currentWorkspaceId("editor"),
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
  if (!localMode()) requireProjectAccess(projectId, "viewer");
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
  if (!localMode()) requireProjectAccess(projectId, "editor");
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

export async function deleteProject(projectId: string): Promise<void> {
  requireProjectAccess(projectId,"editor");
  const database=getDatabase();
  if(database.prepare("SELECT 1 FROM runs WHERE project_id=? AND status IN ('queued','running')").get(projectId) || database.prepare("SELECT 1 FROM pipeline_quality_runs WHERE project_id=? AND status IN ('queued','running')").get(projectId) || database.prepare("SELECT 1 FROM report_runs rr JOIN reports r ON r.id=rr.report_id WHERE r.project_id=? AND rr.status IN ('queued','running')").get(projectId))throw new HttpError(409,"Cancel active loads, preparation and report jobs before deleting this project.");
  const directory=projectUploadDirectory(projectId);
  // Resolve/report checks still need their parent records before the cascading delete.
  const {removeReportExports}=await import("./report-files");
  for(const report of database.prepare("SELECT id FROM reports WHERE project_id=?").all(projectId))removeReportExports(String(report.id));
  const {auditEvent}=await import("@/lib/auth/audit");
  withTransaction(database,()=>{auditEvent("project.deleted","project",projectId);database.prepare("DELETE FROM projects WHERE id=? AND workspace_id=?").run(projectId,currentWorkspaceId("editor"));});
  // A final symlink is unlinked by rm; parent segments are verified before removal.
  let parent=dataDirectory();
  for(const segment of relative(dataDirectory(),directory).split(sep).slice(0,-1)){
    parent=join(/* turbopackIgnore: true */ parent,segment);
    if(!existsSync(/* turbopackIgnore: true */ parent))return;
    const info=lstatSync(/* turbopackIgnore: true */ parent);
    if(info.isSymbolicLink()||!info.isDirectory())return;
  }
  await (await import("node:fs/promises")).rm(/* turbopackIgnore: true */ directory,{recursive:true,force:true});
}
