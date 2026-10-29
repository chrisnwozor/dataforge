import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { LOCAL_WORKSPACE_ID } from "@/lib/auth/migrations";
import { signUp, verifyEmail } from "@/lib/auth/accounts";
import {
  asUser,
  memberFixture,
  userFixture,
  workspaceFixture,
} from "./helpers/auth";
import { listProjects } from "@/lib/server/projects";
import { createProjectFromUpload } from "@/lib/server/uploads";
import { startRun, waitForRunCompletion } from "@/lib/runner";
import { saveConnection } from "@/lib/server/connection";
import { changeMember } from "@/lib/auth/workspaces";
import type { SqlTransport } from "@/lib/runner/sql-transport";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "df-auth-migrations-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "on");
  vi.stubEnv("DATAFORGE_APP_URL", "http://localhost");
  vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 42).toString("base64"));
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
describe("numbered additive tenant migrations", () => {
  it("retains legacy projects, backfills all tenant columns and gives the default workspace to only the first signup", async () => {
    const legacy = new DatabaseSync(join(directory, "dataforge.db")),
      projectId = randomUUID(),
      now = new Date().toISOString();
    legacy.exec(
      "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,source_file TEXT NOT NULL,source_type TEXT NOT NULL,status TEXT NOT NULL,row_count INTEGER NOT NULL,column_count INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)",
    );
    legacy
      .prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        projectId,
        "Retained legacy",
        "sales.csv",
        "CSV",
        "Ready",
        2,
        2,
        now,
        now,
      );
    legacy.close();
    const db = getDatabase();
    expect(
      db
        .prepare("SELECT workspace_id,name FROM projects WHERE id=?")
        .get(projectId),
    ).toMatchObject({
      workspace_id: LOCAL_WORKSPACE_ID,
      name: "Retained legacy",
    });
    expect(
      db.prepare("SELECT name FROM schema_migrations WHERE version=1").get()
        ?.name,
    ).toMatch(/Accounts/);
    for (const table of [
      "projects",
      "runs",
      "dashboards",
      "reports",
      "explore_views",
      "report_runs",
      "report_schedules",
      "project_sources",
      "pipeline_quality_runs",
      "connection_settings",
    ]) {
      expect(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === "workspace_id" && c.notnull === 1),
      ).toBe(true);
    }
    const sent: string[] = [];
    const sender = {
      send: async (message: { text: string }) => {
        sent.push(message.text);
      },
    };
    await signUp(
      {
        email: "first@example.test",
        name: "First",
        password: "first long passphrase",
      },
      new Request("http://localhost"),
      sender,
    );
    verifyEmail(
      new URL(sent[0].match(/https?:\/\/\S+/)![0]).searchParams.get("token")!,
    );
    await signUp(
      {
        email: "second@example.test",
        name: "Second",
        password: "second long passphrase",
      },
      new Request("http://localhost"),
      sender,
    );
    const first = String(
        db
          .prepare("SELECT id FROM users WHERE email='first@example.test'")
          .get()?.id,
      ),
      second = String(
        db
          .prepare("SELECT id FROM users WHERE email='second@example.test'")
          .get()?.id,
      );
    expect(
      asUser(first, LOCAL_WORKSPACE_ID, () => listProjects()).map((p) => p.id),
    ).toEqual([projectId]);
    const secondWorkspace = String(
      db
        .prepare("SELECT workspace_id FROM memberships WHERE user_id=?")
        .get(second)?.workspace_id,
    );
    expect(asUser(second, secondWorkspace, () => listProjects())).toEqual([]);
    closeDatabase();
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=1")
        .get()?.n,
    ).toBe(1);
    expect(
      getDatabase().prepare("PRAGMA foreign_keys").get()?.foreign_keys,
    ).toBe(1);
  });
});
describe("authenticated SQL load driver double", () => {
  it("cancels and releases a running SQL request on role revocation and records a terminal audit event", async () => {
    const owner = userFixture(),
      workspace = workspaceFixture(owner),
      editor = userFixture();
    memberFixture(workspace, editor, "editor");
    asUser(owner, workspace, () =>
      saveConnection({
        server: "driver-double",
        database: "TenantWarehouse",
        user: "sql-login",
        password: "no real database",
        stagingFolder: directory,
      }),
    );
    const form = new FormData();
    form.set("name", "Tenant load");
    form.set(
      "file",
      new File(
        [readFileSync(join(process.cwd(), "samples/superstore_sales.csv"))],
        "sales.csv",
        { type: "text/csv" },
      ),
    );
    const project = await asUser(editor, workspace, () =>
      createProjectFromUpload(
        new Request("http://localhost/api/projects", {
          method: "POST",
          body: form,
        }),
      ),
    );
    let started!: () => void, rejectBatch!: (e: Error) => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    const waiting = new Promise<never>((_r, reject) => {
      rejectBatch = reject;
    });
    const cancel = vi.fn(() =>
        rejectBatch(new Error("Cancelled by access watcher")),
      ),
      rollback = vi.fn(async () => {}),
      close = vi.fn(async () => {});
    const transport: SqlTransport = {
      connect: async () => {},
      batch: async () => {
        started();
        return waiting;
      },
      summary: async () => ({
        rowsStaged: 0,
        rowsLoaded: 0,
        rowsRejected: 0,
        rejected: [],
      }),
      cancel,
      rollback,
      close,
    };
    const run = await asUser(editor, workspace, () =>
      startRun(
        project.project.id,
        {},
        { stageSource: async () => {}, createTransport: () => transport },
      ),
    );
    await entered;
    asUser(owner, workspace, () => changeMember(workspace, editor, "viewer"));
    const result = await asUser(owner, workspace, () =>
      waitForRunCompletion(run.id),
    );
    expect(result.run.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    const events = getDatabase()
      .prepare(
        "SELECT action,workspace_id,user_id FROM audit_events WHERE target_id=? ORDER BY action",
      )
      .all(run.id);
    expect(events).toEqual([
      expect.objectContaining({
        action: "load.finished",
        workspace_id: workspace,
        user_id: editor,
      }),
      expect.objectContaining({
        action: "load.started",
        workspace_id: workspace,
        user_id: editor,
      }),
    ]);
  });
});
