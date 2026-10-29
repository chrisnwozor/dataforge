import type { DatabaseSync } from "node:sqlite";

export const LOCAL_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

/** Called inside the database bootstrap transaction. All identifiers below are static. */
export function migrateAccounts(database: DatabaseSync): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
  if (
    database.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get()
  )
    return;
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE CHECK(email = lower(email)), password_hash TEXT NOT NULL,
      email_verified_at TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL, disabled_at TEXT
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, deleted_at TEXT, audit_retention_days INTEGER NOT NULL DEFAULT 365 CHECK(audit_retention_days BETWEEN 1 AND 3650)
    );
    CREATE TABLE memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')), PRIMARY KEY(workspace_id,user_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL, created_at TEXT NOT NULL,
      workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE email_tokens (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset','invite')), token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL, used_at TEXT
    );
    CREATE TABLE invites (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
      token_id TEXT NOT NULL REFERENCES email_tokens(id) ON DELETE CASCADE, invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE login_attempts (
      key TEXT PRIMARY KEY, failures INTEGER NOT NULL, blocked_until TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
      target_id TEXT, ip TEXT NOT NULL, user_agent TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX audit_workspace_created ON audit_events(workspace_id,created_at DESC,id);
  `);
  database
    .prepare(
      "INSERT INTO workspaces(id,name,slug,created_by,created_at) VALUES (?, ?, ?, NULL, ?)",
    )
    .run(
      LOCAL_WORKSPACE_ID,
      "Local workspace",
      "local",
      new Date().toISOString(),
    );

  // Each child carries its tenant as well as its existing parent FK. Triggers backfill
  // older INSERT statements and reject attempts to move children between tenants.
  const projectTables = [
    "projects",
    "runs",
    "dashboards",
    "reports",
    "explore_views",
    "project_sources",
    "project_pipelines",
    "pipeline_quality_runs",
    "models",
    "column_profiles",
    "semantic_measures",
    "semantic_hierarchies",
    "semantic_state",
  ];
  for (const table of projectTables) {
    database.exec(
      `ALTER TABLE ${table} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${LOCAL_WORKSPACE_ID}' REFERENCES workspaces(id)`,
    );
    database.exec(`CREATE INDEX ${table}_workspace ON ${table}(workspace_id)`);
    if (table === "projects") continue;
    database.exec(`
      CREATE TRIGGER ${table}_tenant_insert AFTER INSERT ON ${table} BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id) THEN RAISE(ABORT, 'FOREIGN KEY constraint failed') END;
        SELECT CASE WHEN NEW.workspace_id != '${LOCAL_WORKSPACE_ID}' AND NEW.workspace_id != (SELECT workspace_id FROM projects WHERE id = NEW.project_id) THEN RAISE(ABORT, 'Tenant mismatch') END;
        UPDATE ${table} SET workspace_id = (SELECT workspace_id FROM projects WHERE id = NEW.project_id) WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER ${table}_tenant_update BEFORE UPDATE ON ${table} WHEN NEW.workspace_id != (SELECT workspace_id FROM projects WHERE id = NEW.project_id) BEGIN SELECT RAISE(ABORT, 'Tenant mismatch'); END;
    `);
  }
  const descendants = [
    ["report_runs", "reports", "report_id"],
    ["report_schedules", "reports", "report_id"],
    ["run_steps", "runs", "run_id"],
    ["run_logs", "runs", "run_id"],
    ["run_reject_rows", "runs", "run_id"],
    ["prepare_rejected_rows", "pipeline_quality_runs", "quality_run_id"],
  ];
  for (const [table, parent, foreignKey] of descendants) {
    database.exec(
      `ALTER TABLE ${table} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '${LOCAL_WORKSPACE_ID}' REFERENCES workspaces(id)`,
    );
    database.exec(`CREATE INDEX ${table}_workspace ON ${table}(workspace_id)`);
    database.exec(`
      CREATE TRIGGER ${table}_tenant_insert AFTER INSERT ON ${table} BEGIN
        SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${parent} WHERE id = NEW.${foreignKey}) THEN RAISE(ABORT, 'FOREIGN KEY constraint failed') END;
        SELECT CASE WHEN NEW.workspace_id != '${LOCAL_WORKSPACE_ID}' AND NEW.workspace_id != (SELECT workspace_id FROM ${parent} WHERE id = NEW.${foreignKey}) THEN RAISE(ABORT, 'Tenant mismatch') END;
        UPDATE ${table} SET workspace_id = (SELECT workspace_id FROM ${parent} WHERE id = NEW.${foreignKey}) WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER ${table}_tenant_update BEFORE UPDATE ON ${table} WHEN NEW.workspace_id != (SELECT workspace_id FROM ${parent} WHERE id = NEW.${foreignKey}) BEGIN SELECT RAISE(ABORT, 'Tenant mismatch'); END;
    `);
  }
  database.exec(`
    ALTER TABLE connection_settings RENAME TO legacy_connection_settings;
    CREATE TABLE connection_settings (
      workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id), id INTEGER NOT NULL DEFAULT 1,
      server TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), database_name TEXT NOT NULL, username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL, encrypt INTEGER NOT NULL CHECK(encrypt IN (0,1)),
      trust_server_certificate INTEGER NOT NULL CHECK(trust_server_certificate IN (0,1)), staging_folder TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO connection_settings SELECT '${LOCAL_WORKSPACE_ID}', * FROM legacy_connection_settings;
    DROP TABLE legacy_connection_settings;
  `);
  database.exec(`ALTER TABLE report_schedules ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;
    CREATE TRIGGER projects_workspace_immutable BEFORE UPDATE OF workspace_id ON projects WHEN NEW.workspace_id != OLD.workspace_id BEGIN SELECT RAISE(ABORT, 'Project workspace cannot change'); END;`);
  database
    .prepare(
      "INSERT INTO schema_migrations(version,name,applied_at) VALUES(1,?,?)",
    )
    .run(
      "Accounts, workspaces, tenant backfill and audit",
      new Date().toISOString(),
    );
}
