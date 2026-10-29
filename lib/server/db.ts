import { migrateVerification } from "@/lib/verify/migrations";
import { migrateAccounts } from "@/lib/auth/migrations";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const globalDatabases = globalThis as typeof globalThis & {
  dataforgeDatabases?: Map<string, DatabaseSync>;
};

/** The override keeps automated checks isolated from a developer's stored data. */
export function dataDirectory(): string {
  return resolve(/* turbopackIgnore: true */ process.env.DATAFORGE_DATA_DIR || join(process.cwd(), "data"));
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
        max_length INTEGER CHECK (max_length >= 0),
        max_decimal_places INTEGER CHECK (max_decimal_places >= 0 AND max_decimal_places <= 6),
        PRIMARY KEY (project_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS models (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('suggested', 'edited')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connection_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        password_encrypted TEXT NOT NULL,
        encrypt INTEGER NOT NULL CHECK (encrypt IN (0, 1)),
        trust_server_certificate INTEGER NOT NULL CHECK (trust_server_certificate IN (0, 1)),
        staging_folder TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        rows_staged INTEGER NOT NULL DEFAULT 0 CHECK (rows_staged >= 0),
        rows_loaded INTEGER NOT NULL DEFAULT 0 CHECK (rows_loaded >= 0),
        rows_rejected INTEGER NOT NULL DEFAULT 0 CHECK (rows_rejected >= 0),
        error_file TEXT,
        error_message TEXT,
        error_batch INTEGER,
        error_number INTEGER,
        error_line INTEGER,
        owner_pid INTEGER,
        options_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_project
        ON runs(project_id) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS run_steps (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        file TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped')),
        started_at TEXT,
        finished_at TEXT,
        rows_affected INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        PRIMARY KEY (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'SUCCESS')),
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_logs_run_id ON run_logs(run_id, id);
      CREATE TABLE IF NOT EXISTS run_reject_rows (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        source_row_number INTEGER NOT NULL,
        reason TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (run_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS semantic_measures (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        expression TEXT NOT NULL,
        format TEXT NOT NULL,
        folder TEXT NOT NULL,
        description TEXT NOT NULL,
        is_auto INTEGER NOT NULL CHECK (is_auto IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS semantic_hierarchies (
        id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        "table" TEXT NOT NULL,
        levels TEXT NOT NULL,
        is_auto INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0, 1)),
        PRIMARY KEY (project_id, id)
      );
      CREATE TABLE IF NOT EXISTS semantic_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explore_views (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS explore_views_project_updated
        ON explore_views(project_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        layout TEXT NOT NULL,
        filters TEXT NOT NULL,
        settings TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dashboards_project_updated
        ON dashboards(project_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        definition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reports_project_updated ON reports(project_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS report_runs (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        params TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
        page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        file_paths TEXT NOT NULL DEFAULT '{}',
        owner_pid INTEGER,
        trigger_type TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('manual', 'scheduled'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS report_runs_one_active ON report_runs(report_id) WHERE status IN ('queued', 'running');
      CREATE INDEX IF NOT EXISTS report_runs_report_started ON report_runs(report_id, started_at DESC, id);
      CREATE TABLE IF NOT EXISTS report_schedules (
        id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        params TEXT NOT NULL,
        formats TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        last_run_at TEXT,
        next_run_at TEXT
      );
      CREATE INDEX IF NOT EXISTS report_schedules_due ON report_schedules(enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS project_sources (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('csv', 'xlsx', 'json')),
        file_path TEXT NOT NULL,
        options TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        columns TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_sources_project_created ON project_sources(project_id, created_at, id);
      CREATE TABLE IF NOT EXISTS project_pipelines (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        definition TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        progress TEXT,
        error TEXT,
        prepared_path TEXT,
        profiled_version INTEGER,
        quality_run_id TEXT,
        profile_report TEXT,
        missing_columns TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS pipeline_quality_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        pipeline_version INTEGER NOT NULL,
        warehouse_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        summary TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT,
        rejects_path TEXT,
        owner_pid INTEGER
      );
      CREATE INDEX IF NOT EXISTS pipeline_quality_runs_project_started ON pipeline_quality_runs(project_id, started_at DESC, id);
      CREATE TABLE IF NOT EXISTS prepare_rejected_rows (
        quality_run_id TEXT NOT NULL REFERENCES pipeline_quality_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
        step_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        bucket TEXT,
        source_row_number INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        PRIMARY KEY (quality_run_id, ordinal)
      );
    `);
    // Serialize additive migrations across development workers opening the same file.
    // SQLite requires FK checks off while adding a REFERENCES column with a
    // non-null default to populated legacy tables. Restore before exposing the handle.
    database.exec("PRAGMA foreign_keys = OFF");
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
      if (!profileColumns.has("max_length"))
        database.exec(
          "ALTER TABLE column_profiles ADD COLUMN max_length INTEGER CHECK (max_length >= 0)",
        );
      if (!profileColumns.has("max_decimal_places"))
        database.exec(
          "ALTER TABLE column_profiles ADD COLUMN max_decimal_places INTEGER CHECK (max_decimal_places >= 0 AND max_decimal_places <= 6)",
        );
      const runColumns = new Set(
        database
          .prepare("PRAGMA table_info(runs)")
          .all()
          .map((row) => row.name),
      );
      if (!runColumns.has("owner_pid"))
        database.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
      if (!runColumns.has("prepare_summary"))
        database.exec("ALTER TABLE runs ADD COLUMN prepare_summary TEXT");
      const hierarchyColumns = new Set(
        database
          .prepare("PRAGMA table_info(semantic_hierarchies)")
          .all()
          .map((row) => row.name),
      );
      if (!hierarchyColumns.has("is_auto"))
        database.exec(
          "ALTER TABLE semantic_hierarchies ADD COLUMN is_auto INTEGER NOT NULL DEFAULT 0 CHECK (is_auto IN (0, 1))",
        );
      migrateAccounts(database);
      migrateVerification(database);
      database.exec("COMMIT");
      database.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      database.exec("ROLLBACK");
      database.exec("PRAGMA foreign_keys = ON");
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
