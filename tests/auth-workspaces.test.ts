import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  acceptInvite,
  changeMember,
  createWorkspace,
  deleteWorkspace,
  inviteMember,
  leaveWorkspace,
  listWorkspaces,
  renameWorkspace,
  switchWorkspace,
  transferOwnership,
} from "@/lib/auth/workspaces";
import {
  authContext,
  currentWorkspaceId,
  requireWorkspaceRole,
  roleAllows,
  roles,
  actions,
  createJobAccess,
  requireProjectAccess,
} from "@/lib/auth/context";
import {
  encryptWorkspacePassword,
  decryptWorkspacePassword,
} from "@/lib/auth/workspace-secrets";
import { encryptPassword } from "@/lib/runner/secrets";
import { auditEvent, pruneAudit, readAudit } from "@/lib/auth/audit";
import { createSession, readSession } from "@/lib/auth/sessions";
import {
  saveConnection,
  readPublicConnection,
  getConnectionSettings,
} from "@/lib/server/connection";
import { runScheduledContext } from "@/lib/auth/scheduled";
import type { EmailMessage } from "@/lib/auth/email";
import {
  asUser,
  memberFixture,
  projectFixture,
  userFixture,
  workspaceFixture,
} from "./helpers/auth";
import { createReport, createReportSchedule } from "@/lib/server/reports";
import { createEmptyReport } from "@/lib/reports/schema";
let directory: string, owner: string, workspace: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "df-auth-workspaces-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "on");
  vi.stubEnv("DATAFORGE_APP_URL", "http://localhost");
  vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 31).toString("base64"));
  vi.stubEnv("DATAFORGE_SECRET_KEY_ID", "primary");
  owner = userFixture();
  workspace = workspaceFixture(owner);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});
describe("complete role/action matrix", () => {
  for (const role of roles)
    for (const [action, required] of Object.entries(actions)) {
      it(`${role} ${action}`, () => {
        expect(roleAllows(role, action as keyof typeof actions)).toBe(
          roles.indexOf(role) >= roles.indexOf(required),
        );
      });
    }
});
describe("workspace administration", () => {
  it("creates an owner membership, switches a session, renames and scopes workspace lists", () => {
    asUser(owner, workspace, () => {
      const created = createWorkspace("Review team");
      expect(requireWorkspaceRole(created.id, "owner").role).toBe("owner");
      renameWorkspace(created.id, "Reviewers");
      expect(listWorkspaces().map((w) => w.name)).toContain("Reviewers");
      const s = createSession(owner),
        context = readSession(s.token)!;
      authContext.run(context, () => switchWorkspace(created.id));
      expect(readSession(s.token)?.workspaceId).toBe(created.id);
    });
    const other = userFixture();
    expect(
      asUser(other, workspaceFixture(other), () => listWorkspaces()),
    ).toHaveLength(1);
  });
  it("prevents deleting, leaving, removing or demoting the last owner", () => {
    asUser(owner, workspace, () => {
      expect(() => leaveWorkspace(workspace)).toThrow(/at least one owner/);
      expect(() => changeMember(workspace, owner, "admin")).toThrow(
        /at least one owner/,
      );
      expect(() => changeMember(workspace, owner, null)).toThrow(
        /at least one owner/,
      );
    });
  });
  it("transfers ownership atomically and permits former owner to leave", () => {
    const second = userFixture();
    memberFixture(workspace, second, "editor");
    asUser(owner, workspace, () => transferOwnership(workspace, second));
    expect(
      getDatabase()
        .prepare(
          "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
        )
        .get(workspace, second)?.role,
    ).toBe("owner");
    expect(
      asUser(
        owner,
        workspace,
        () => requireWorkspaceRole(workspace, "admin").role,
      ),
    ).toBe("admin");
    asUser(owner, workspace, () => leaveWorkspace(workspace));
    expect(() =>
      asUser(owner, workspace, () => requireWorkspaceRole(workspace)),
    ).toThrow(/not found/);
  });
  it("blocks administrators from promoting themselves, managing owners and deleting a workspace", () => {
    const admin = userFixture();
    memberFixture(workspace, admin, "admin");
    asUser(admin, workspace, () => {
      expect(() => changeMember(workspace, admin, "owner")).toThrow(
        /Only an owner/,
      );
      expect(() => changeMember(workspace, owner, null)).toThrow();
      expect(() => deleteWorkspace(workspace)).toThrow(/role/);
      expect(() => transferOwnership(workspace, admin)).toThrow();
    });
  });
  it("keeps a workspace inaccessible after deletion even to its former owner", () => {
    asUser(owner, workspace, () => deleteWorkspace(workspace));
    expect(() =>
      asUser(owner, workspace, () => requireWorkspaceRole(workspace)),
    ).toThrow(/not found/);
    expect(asUser(owner, workspace, () => listWorkspaces())).toEqual([]);
  });
  it("accepts a matching-address invitation once and verifies its email; wrong-address attempts do not burn it", async () => {
    let message: EmailMessage | undefined;
    const second = userFixture("second@example.test", false),
      other = userFixture();
    await asUser(owner, workspace, () =>
      inviteMember(workspace, "SECOND@example.test", "editor", {
        send: async (m) => {
          message = m;
        },
      }),
    );
    const token = new URL(
      message!.text.match(/https?:\/\/\S+/)![0],
    ).searchParams.get("token")!;
    expect(() =>
      asUser(other, workspaceFixture(other), () => acceptInvite(token)),
    ).toThrow(/email address/);
    expect(asUser(second, workspace, () => acceptInvite(token))).toBe(
      workspace,
    );
    expect(
      asUser(second, workspace, () => requireWorkspaceRole(workspace).role),
    ).toBe("editor");
    expect(() => asUser(second, workspace, () => acceptInvite(token))).toThrow(
      /used/,
    );
    expect(
      getDatabase()
        .prepare("SELECT email_verified_at FROM users WHERE id=?")
        .get(second)?.email_verified_at,
    ).toBeTruthy();
  });
  it("invalidates invitations if the inviter loses administrator access", async () => {
    const admin = userFixture(),
      second = userFixture("new@example.test");
    memberFixture(workspace, admin, "admin");
    let message: EmailMessage | undefined;
    await asUser(admin, workspace, () =>
      inviteMember(workspace, "new@example.test", "viewer", {
        send: async (m) => {
          message = m;
        },
      }),
    );
    asUser(owner, workspace, () => changeMember(workspace, admin, "editor"));
    const token = new URL(
      message!.text.match(/https?:\/\/\S+/)![0],
    ).searchParams.get("token")!;
    expect(() => asUser(second, workspace, () => acceptInvite(token))).toThrow(
      /no longer active/,
    );
  });
  it("does not permit an admin to invite another administrator", async () => {
    const admin = userFixture();
    memberFixture(workspace, admin, "admin");
    await expect(
      asUser(admin, workspace, () =>
        inviteMember(workspace, "new@example.test", "admin", { send: vi.fn() }),
      ),
    ).rejects.toThrow(/Only an owner/);
  });
});
describe("per-workspace encryption and connections", () => {
  it("authenticates both workspace and key id and cannot decrypt another tenant's envelope", () => {
    const a = encryptWorkspacePassword("sql password", workspace);
    expect(a).toMatch(/^v2:primary:/);
    expect(decryptWorkspacePassword(a, workspace)).toBe("sql password");
    expect(() => decryptWorkspacePassword(a, workspaceFixture(owner))).toThrow(
      /could not/,
    );
    expect(() =>
      decryptWorkspacePassword(a.replace(":primary:", ":other:"), workspace),
    ).toThrow();
    expect(() =>
      decryptWorkspacePassword(a.slice(0, -2) + "zz", workspace),
    ).toThrow();
  });
  it("reads a previous key during rotation and re-encrypts with the new id on save", () => {
    const old = process.env.DATAFORGE_SECRET!,
      cipher = encryptWorkspacePassword("old secret", workspace);
    vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 47).toString("base64"));
    vi.stubEnv("DATAFORGE_SECRET_KEY_ID", "2027");
    vi.stubEnv(
      "DATAFORGE_SECRET_PREVIOUS_KEYS",
      JSON.stringify({ primary: old }),
    );
    expect(decryptWorkspacePassword(cipher, workspace)).toBe("old secret");
    const next = encryptWorkspacePassword(
      decryptWorkspacePassword(cipher, workspace),
      workspace,
    );
    expect(next).toMatch(/^v2:2027:/);
    vi.stubEnv("DATAFORGE_SECRET_PREVIOUS_KEYS", "{}");
    expect(decryptWorkspacePassword(next, workspace)).toBe("old secret");
    expect(() => decryptWorkspacePassword(cipher, workspace)).toThrow();
  });
  it("supports legacy ciphertext only for the migrated default workspace", () => {
    const legacy = encryptPassword("legacy password");
    expect(
      decryptWorkspacePassword(legacy, "00000000-0000-4000-8000-000000000001"),
    ).toBe("legacy password");
    expect(() => decryptWorkspacePassword(legacy, workspace)).toThrow();
  });
  it("persists independent connections, returns only masked fields, and writes audit events", () => {
    const second = workspaceFixture(owner);
    const input = {
      server: "server",
      database: "Warehouse",
      user: "sql-login",
      password: "not returned",
      stagingFolder: "/tmp",
      encrypt: true,
      trustServerCertificate: true,
    };
    asUser(owner, workspace, () => saveConnection(input));
    asUser(owner, second, () =>
      saveConnection({
        ...input,
        password: "other secret",
        database: "Second",
      }),
    );
    asUser(owner, workspace, () => {
      expect(getConnectionSettings().database).toBe("Warehouse");
      expect(getConnectionSettings().password).toBe("not returned");
      expect(JSON.stringify(readPublicConnection())).not.toContain(
        "not returned",
      );
      expect(readPublicConnection().passwordSaved).toBe(true);
      expect(
        readAudit().filter((e) => e.action === "connection.created"),
      ).toHaveLength(1);
    });
    expect(asUser(owner, second, () => getConnectionSettings().password)).toBe(
      "other secret",
    );
  });
});
describe("audit and background access", () => {
  it("stores only allowlisted metadata, filters tenants and prunes using workspace retention", () => {
    asUser(owner, workspace, () => {
      auditEvent("member.role_changed", "user", owner, {
        role: "viewer",
        password: "never stored",
        token: "never stored",
        nested: { secret: "never stored" },
      });
      const events = readAudit();
      expect(events[0].metadata).toEqual({ role: "viewer" });
      expect(JSON.stringify(events)).not.toContain("never stored");
    });
    const other = workspaceFixture(owner);
    expect(asUser(owner, other, () => readAudit())).toEqual([]);
    getDatabase()
      .prepare("UPDATE audit_events SET created_at=?")
      .run("2000-01-01T00:00:00.000Z");
    expect(pruneAudit()).toBe(1);
  });
  it("cancels a background lease on demotion but permits only captured project terminal bookkeeping", async () => {
    vi.useFakeTimers();
    const editor = userFixture(),
      project = projectFixture(workspace);
    memberFixture(workspace, editor, "editor");
    const lease = asUser(editor, workspace, () =>
        createJobAccess(project, "editor"),
      ),
      controller = new AbortController(),
      cancel = vi.fn(),
      stop = lease.watch(controller, cancel);
    memberFixture(workspace, editor, "viewer");
    await vi.advanceTimersByTimeAsync(251);
    expect(controller.signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(() => lease.assert()).toThrow();
    expect(lease.finish(() => currentWorkspaceId())).toBe(workspace);
    expect(() =>
      lease.finish(() => requireProjectAccess(project, "admin")),
    ).toThrow(/elevate/);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel).toHaveBeenCalledOnce();
    stop();
  });
  it("runs schedules as the saved administrator and re-checks workspace/user/role", () => {
    const project = projectFixture(workspace);
    let scheduleId = "";
    asUser(owner, workspace, () => {
      const report = createReport(project, createEmptyReport("Scheduled"));
      scheduleId = createReportSchedule(project, report.id, {
        cron: "* * * * *",
        timezone: "UTC",
        params: {},
        formats: ["csv"],
        enabled: true,
      }).id;
    });
    expect(
      runScheduledContext(scheduleId, project, () => currentWorkspaceId()),
    ).toBe(workspace);
    getDatabase()
      .prepare("UPDATE users SET disabled_at=? WHERE id=?")
      .run(new Date().toISOString(), owner);
    expect(() =>
      runScheduledContext(scheduleId, project, () => "should not run"),
    ).toThrow(/no longer active/);
  });
});
