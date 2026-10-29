import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabase, withTransaction } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import {
  currentContext,
  currentWorkspaceId,
  requireWorkspaceRole,
  type Role,
} from "./context";
import { auditEvent } from "./audit";
import { issueEmailToken, consumeEmailToken } from "./tokens";
import { defaultEmailSender, emailTemplate, type EmailSender } from "./email";
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    "Use a name without control characters.",
  );
export function listWorkspaces() {
  const context = currentContext(),
    db = getDatabase();
  if (context.local)
    return [
      {
        id: context.workspaceId,
        name: "Local workspace",
        slug: "local",
        role: "owner" as Role,
      },
    ];
  return db
    .prepare(
      "SELECT w.id,w.name,w.slug,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at,w.id",
    )
    .all(context.user.id) as unknown as {
    id: string;
    name: string;
    slug: string;
    role: Role;
  }[];
}
export function createWorkspace(name: string) {
  const context = currentContext();
  if (context.local)
    throw new HttpError(409, "Enable accounts to create more workspaces.");
  name = workspaceNameSchema.parse(name);
  const id = randomUUID(),
    slug = `${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "workspace"
    }-${id.slice(0, 8)}`;
  const db = getDatabase();
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO workspaces(id,name,slug,created_by,created_at) VALUES(?,?,?,?,?)",
    ).run(id, name, slug, context.user.id, new Date().toISOString());
    db.prepare(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
    ).run(id, context.user.id);
  });
  auditEvent("workspace.created", "workspace", id, {}, { workspaceId: id });
  return { id, name, slug, role: "owner" as Role };
}
export function switchWorkspace(workspaceId: string): void {
  const context = currentContext();
  requireWorkspaceRole(workspaceId);
  if (context.sessionId)
    getDatabase()
      .prepare("UPDATE sessions SET workspace_id=? WHERE id=? AND user_id=?")
      .run(workspaceId, context.sessionId, context.user.id);
  context.workspaceId = workspaceId;
}
export function renameWorkspace(workspaceId: string, name: string): void {
  requireWorkspaceRole(workspaceId, "admin");
  name = workspaceNameSchema.parse(name);
  getDatabase()
    .prepare("UPDATE workspaces SET name=? WHERE id=? AND deleted_at IS NULL")
    .run(name, workspaceId);
  auditEvent(
    "workspace.renamed",
    "workspace",
    workspaceId,
    {},
    { workspaceId },
  );
}
function guardLastOwner(workspaceId: string, userId: string): void {
  const db = getDatabase();
  if (
    db
      .prepare(
        "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
      )
      .get(workspaceId, userId)?.role === "owner" &&
    Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'",
        )
        .get(workspaceId)?.count,
    ) <= 1
  )
    throw new HttpError(
      409,
      "A workspace must keep at least one owner. Transfer ownership first.",
    );
}
export function changeMember(
  workspaceId: string,
  userId: string,
  role: Role | null,
): void {
  const actor = requireWorkspaceRole(workspaceId, "admin"),
    db = getDatabase();
  const member = db
    .prepare("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?")
    .get(workspaceId, userId);
  if (!member) throw new HttpError(404, "Member not found.");
  if (
    (member.role === "owner" ||
      role === "owner" ||
      (role === "admin" && member.role !== "admin") ||
      (member.role === "admin" && userId !== currentContext().user.id)) &&
    actor.role !== "owner"
  )
    throw new HttpError(
      403,
      "Only an owner can manage owners or other administrators.",
    );
  withTransaction(db, () => {
    if (role !== "owner") guardLastOwner(workspaceId, userId);
    if (role)
      db.prepare(
        "UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?",
      ).run(role, workspaceId, userId);
    else
      db.prepare(
        "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
      ).run(workspaceId, userId);
  });
  auditEvent(
    role ? "member.role_changed" : "member.removed",
    "user",
    userId,
    { role: role ?? "removed", previousRole: member.role },
    { workspaceId },
  );
}
export function leaveWorkspace(workspaceId: string): void {
  requireWorkspaceRole(workspaceId);
  const db = getDatabase(),
    userId = currentContext().user.id;
  withTransaction(db, () => {
    guardLastOwner(workspaceId, userId);
    db.prepare(
      "DELETE FROM memberships WHERE workspace_id=? AND user_id=?",
    ).run(workspaceId, userId);
  });
  auditEvent("member.left", "user", userId, {}, { workspaceId });
}
export function transferOwnership(workspaceId: string, userId: string): void {
  requireWorkspaceRole(workspaceId, "owner");
  const context = currentContext(),
    db = getDatabase();
  if (userId === context.user.id)
    throw new HttpError(400, "Choose another active member.");
  withTransaction(db, () => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND u.disabled_at IS NULL",
        )
        .get(workspaceId, userId)
    )
      throw new HttpError(404, "Member not found.");
    db.prepare(
      "UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?",
    ).run(workspaceId, userId);
    db.prepare(
      "UPDATE memberships SET role='admin' WHERE workspace_id=? AND user_id=?",
    ).run(workspaceId, context.user.id);
  });
  auditEvent(
    "workspace.ownership_transferred",
    "user",
    userId,
    {},
    { workspaceId },
  );
}
export function deleteWorkspace(workspaceId: string): void {
  requireWorkspaceRole(workspaceId, "owner");
  if (currentContext().local)
    throw new HttpError(
      409,
      "The development workspace cannot be deleted in local mode.",
    );
  auditEvent(
    "workspace.deleted",
    "workspace",
    workspaceId,
    {},
    { workspaceId },
  );
  getDatabase()
    .prepare("UPDATE workspaces SET deleted_at=? WHERE id=?")
    .run(new Date().toISOString(), workspaceId);
}
export function listMembers(workspaceId: string) {
  requireWorkspaceRole(workspaceId, "admin");
  return getDatabase()
    .prepare(
      "SELECT u.id,u.name,u.email,m.role,u.email_verified_at AS emailVerifiedAt FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND u.disabled_at IS NULL ORDER BY u.name,u.email",
    )
    .all(workspaceId);
}
export function listInvites(workspaceId: string) {
  requireWorkspaceRole(workspaceId, "admin");
  return getDatabase()
    .prepare(
      "SELECT i.id,i.email,i.role,t.expires_at AS expiresAt FROM invites i JOIN email_tokens t ON t.id=i.token_id WHERE i.workspace_id=? AND t.used_at IS NULL AND t.expires_at>? ORDER BY i.created_at DESC",
    )
    .all(workspaceId, new Date().toISOString());
}
export async function inviteMember(
  workspaceId: string,
  email: string,
  role: "admin" | "editor" | "viewer",
  sender: EmailSender = defaultEmailSender,
): Promise<void> {
  const actor = requireWorkspaceRole(workspaceId, "admin"),
    context = currentContext(),
    db = getDatabase();
  email = z.email().max(254).parse(email.trim().toLowerCase());
  if (role === "admin" && actor.role !== "owner")
    throw new HttpError(403, "Only an owner can invite an administrator.");
  const user = db
    .prepare("SELECT id FROM users WHERE email=? AND disabled_at IS NULL")
    .get(email);
  if (
    user &&
    db
      .prepare("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?")
      .get(workspaceId, user.id)
  )
    throw new HttpError(409, "That person is already a member.");
  const token = withTransaction(db, () => {
    db.prepare(
      "UPDATE email_tokens SET used_at=? WHERE id IN (SELECT token_id FROM invites WHERE workspace_id=? AND email=?) AND used_at IS NULL",
    ).run(new Date().toISOString(), workspaceId, email);
    const issued = issueEmailToken(user ? String(user.id) : null, "invite");
    db.prepare(
      "INSERT INTO invites(id,workspace_id,email,role,token_id,invited_by,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      workspaceId,
      email,
      role,
      issued.id,
      context.user.id,
      new Date().toISOString(),
    );
    return issued;
  });
  try {
    await sender.send(
      emailTemplate(
        email,
        "invite",
        token.token,
        String(
          db.prepare("SELECT name FROM workspaces WHERE id=?").get(workspaceId)
            ?.name,
        ),
      ),
    );
  } catch (error) {
    db.prepare("DELETE FROM email_tokens WHERE id=?").run(token.id);
    throw error;
  }
  auditEvent(
    "member.invited",
    "workspace",
    workspaceId,
    { role },
    { workspaceId },
  );
}
export function acceptInvite(token: string): string {
  const context = currentContext(),
    db = getDatabase();
  if (context.local)
    throw new HttpError(409, "Enable accounts to accept an invitation.");
  const workspaceId = withTransaction(db, () => {
    const consumed = consumeEmailToken(token, "invite");
    const invite = db
      .prepare(
        "SELECT i.workspace_id,i.email,i.role,i.invited_by FROM invites i JOIN workspaces w ON w.id=i.workspace_id WHERE i.token_id=? AND w.deleted_at IS NULL",
      )
      .get(consumed.id);
    if (!invite || invite.email !== context.user.email)
      throw new HttpError(
        400,
        "Sign in with the email address that received this invitation.",
      );
    const inviter = db
      .prepare(
        "SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.user_id=? AND u.disabled_at IS NULL",
      )
      .get(invite.workspace_id, invite.invited_by);
    if (
      !inviter ||
      !["owner", "admin"].includes(String(inviter.role)) ||
      (invite.role === "admin" && inviter.role !== "owner")
    )
      throw new HttpError(
        400,
        "This invitation is no longer active. Ask an administrator for a new one.",
      );
    db.prepare(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING",
    ).run(invite.workspace_id, context.user.id, invite.role);
    db.prepare(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?",
    ).run(new Date().toISOString(), context.user.id);
    return String(invite.workspace_id);
  });
  switchWorkspace(workspaceId);
  auditEvent("member.joined", "user", context.user.id, {}, { workspaceId });
  return workspaceId;
}
export function setAuditRetention(days: number): void {
  const workspaceId = currentWorkspaceId("admin");
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new HttpError(400, "Retention must be between 1 and 3,650 days.");
  getDatabase()
    .prepare("UPDATE workspaces SET audit_retention_days=? WHERE id=?")
    .run(days, workspaceId);
  auditEvent("audit.retention_changed", "workspace", workspaceId, {
    retentionDays: days,
  });
}
