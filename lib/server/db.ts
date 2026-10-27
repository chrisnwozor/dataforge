import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const globalDatabases = globalThis as typeof globalThis & {
  dataforgeDatabases?: Map<string, DatabaseSync>;
};

/** The override keeps automated checks isolated from a developer's stored data. */
export function dataDirectory(): string {
  return resolve(process.env.DATAFORGE_DATA_DIR || join(process.cwd(), "data"));
}

export function getDatabase(): DatabaseSync {
  const directory = dataDirectory();
  const filename = join(directory, "dataforge.db");
  const databases = (globalDatabases.dataforgeDatabases ??= new Map());
  const existing = databases.get(filename);
  if (existing) return existing;

  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_file TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('CSV', 'XLSX')),
        status TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        column_count INTEGER NOT NULL CHECK (column_count >= 0),
        duplicate_row_count INTEGER CHECK (duplicate_row_count >= 0),
        total_null_cells INTEGER CHECK (total_null_cells >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS column_profiles (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        name TEXT NOT NULL,
        inferred_type TEXT NOT NULL,
        override_type TEXT,
        null_pct REAL NOT NULL,
        null_count INTEGER CHECK (null_count >= 0),
        distinct_count INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL,
        min_value TEXT,
        max_value TEXT,
        is_key_candidate INTEGER NOT NULL CHECK (is_key_candidate IN (0, 1)),
        is_near_key_candidate INTEGER NOT NULL DEFAULT 0 CHECK (is_near_key_candidate IN (0, 1)),
        sample_values TEXT NOT NULL,
        PRIMARY KEY (project_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS models (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('suggested', 'edited')),
        updated_at TEXT NOT NULL
      );
    `);
    // Serialize additive migrations across development workers opening the same file.
    database.exec("BEGIN IMMEDIATE");
    try {
      const projectColumns = new Set(
        database
          .prepare("PRAGMA table_info(projects)")
          .all()
          .map((row) => row.name),
      );
      if (!projectColumns.has("duplicate_row_count"))
        database.exec(
          "ALTER TABLE projects ADD COLUMN duplicate_row_count INTEGER CHECK (duplicate_row_count >= 0)",
        );
      if (!projectColumns.has("total_null_cells"))
        database.exec(
          "ALTER TABLE projects ADD COLUMN total_null_cells INTEGER CHECK (total_null_cells >= 0)",
        );
      const profileColumns = new Set(
        database
          .prepare("PRAGMA table_info(column_profiles)")
          .all()
          .map((row) => row.name),
      );
      if (!profileColumns.has("null_count"))
        database.exec(
          "ALTER TABLE column_profiles ADD COLUMN null_count INTEGER CHECK (null_count >= 0)",
        );
      if (!profileColumns.has("is_near_key_candidate"))
        database.exec(
          "ALTER TABLE column_profiles ADD COLUMN is_near_key_candidate INTEGER NOT NULL DEFAULT 0 CHECK (is_near_key_candidate IN (0, 1))",
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    databases.set(filename, database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Keep multi-statement writes atomic without a driver-specific transaction API. */
export function withTransaction<T>(
  database: DatabaseSync,
  callback: () => T,
): T {
  database.exec("BEGIN");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Release database handles before deleting a temporary test directory. */
export function closeDatabase(): void {
  for (const database of globalDatabases.dataforgeDatabases?.values() ?? []) {
    database.close();
  }
  globalDatabases.dataforgeDatabases?.clear();
}
