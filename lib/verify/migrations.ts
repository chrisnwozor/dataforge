import type { DatabaseSync } from "node:sqlite";
/** Runs in the existing serialized additive-migration transaction. */
export function migrateVerification(database: DatabaseSync): void {
  if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=2").get())
    return;
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS projects_tenant_identity ON projects(id,workspace_id);
    CREATE TABLE verification_settings (
      project_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),json TEXT NOT NULL,updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id) ON DELETE CASCADE
    );
    CREATE TABLE verification_runs (
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,model_version TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
      trigger TEXT NOT NULL CHECK(trigger IN ('manual','load')),started_at TEXT NOT NULL,finished_at TEXT,
      total INTEGER NOT NULL DEFAULT 0 CHECK(total>=0),completed INTEGER NOT NULL DEFAULT 0 CHECK(completed>=0),current_check TEXT,
      counts_json TEXT NOT NULL,error TEXT,owner_pid INTEGER,snapshot_json TEXT NOT NULL,
      FOREIGN KEY(project_id,workspace_id) REFERENCES projects(id,workspace_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX verification_one_active ON verification_runs(project_id) WHERE status IN ('queued','running');
    CREATE INDEX verification_history ON verification_runs(project_id,started_at DESC,id);
    CREATE TABLE verification_results (
      run_id TEXT NOT NULL REFERENCES verification_runs(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL CHECK(ordinal>=0),result_id TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(run_id,ordinal),UNIQUE(run_id,result_id)
    );
  `);
  database
    .prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES(2,?,?)",
    )
    .run(
      "Independent pipeline verification and history",
      new Date().toISOString(),
    );
}
