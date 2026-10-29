import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabase, withTransaction } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { hashPassword, verifyPassword } from "./passwords";
import {
  createSession,
  cookieToken,
  requestIdentity,
  revokeSessions,
} from "./sessions";
import { issueEmailToken, consumeEmailToken, tokenHash } from "./tokens";
import {
  defaultEmailSender,
  emailTemplate,
  assertEmailConfiguration,
  sendAccountEmail,
  type EmailSender,
} from "./email";
import {
  checkThrottle,
  recordFailure,
  throttleKeys,
  clearAccountThrottle,
} from "./throttle";
import { currentContext } from "./context";
import { auditEvent } from "./audit";
import { LOCAL_WORKSPACE_ID } from "./migrations";
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    "Use a name without control characters.",
  );
export const signupSchema = z
  .object({
    email: emailSchema,
    name: nameSchema,
    password: z.string().min(12).max(1024),
  })
  .strict();
function accountWorkspace(userId: string): string | null {
  const row = getDatabase()
    .prepare(
      "SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at,w.id LIMIT 1",
    )
    .get(userId);
  return row ? String(row.workspace_id) : null;
}

export async function signUp(
  input: unknown,
  request: Request,
  sender: EmailSender = defaultEmailSender,
): Promise<void> {
  assertEmailConfiguration();
  const { email, name, password } = signupSchema.parse(input),
    identity = requestIdentity(request),
    keys = [`signup:${identity.ip}`];
  checkThrottle(keys);
  recordFailure(keys);
  // Always do password work and return the same response for existing addresses.
  const passwordHash = await hashPassword(password),
    db = getDatabase();
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return;
  const id = randomUUID(),
    now = new Date().toISOString();
  const issued = withTransaction(db, () => {
    db.prepare(
      "INSERT INTO users(id,email,password_hash,name,created_at) VALUES(?,?,?,?,?)",
    ).run(id, email, passwordHash, name, now);
    const first = db
      .prepare(
        "UPDATE workspaces SET created_by=?, name=? WHERE id=? AND created_by IS NULL AND deleted_at IS NULL RETURNING id",
      )
      .get(id, `${name}'s workspace`, LOCAL_WORKSPACE_ID);
    const workspaceId = first ? LOCAL_WORKSPACE_ID : randomUUID();
    if (!first)
      db.prepare(
        "INSERT INTO workspaces(id,name,slug,created_by,created_at) VALUES(?,?,?,?,?)",
      ).run(workspaceId, `${name}'s workspace`, `personal-${id}`, id, now);
    db.prepare(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,'owner')",
    ).run(workspaceId, id);
    if (first)
      db.prepare(
        "UPDATE report_schedules SET created_by=? WHERE workspace_id=? AND created_by IS NULL",
      ).run(id, workspaceId);
    return issueEmailToken(id, "verify");
  });
  try {
    await sendAccountEmail(
      emailTemplate(email, "verify", issued.token),
      sender,
    );
  } catch (error) {
    // The account remains recoverable through the generic resend-verification flow.
    db.prepare("DELETE FROM email_tokens WHERE id=?").run(issued.id);
    throw error;
  }
  auditEvent(
    "account.created",
    "user",
    id,
    {},
    { userId: id, workspaceId: accountWorkspace(id), ...identity },
  );
}
export async function signIn(
  emailInput: string,
  password: string,
  request: Request,
): Promise<{ token: string; id: string }> {
  const email = emailInput.trim().toLowerCase(),
    identity = requestIdentity(request),
    keys = throttleKeys(email, identity.ip),
    db = getDatabase();
  try {
    checkThrottle(keys);
  } catch (error) {
    auditEvent(
      "auth.login_failed",
      "account",
      null,
      { reason: "throttled" },
      identity,
    );
    throw error;
  }
  const user = db
    .prepare(
      "SELECT id,password_hash,disabled_at,email_verified_at FROM users WHERE email=?",
    )
    .get(email);
  const valid = await verifyPassword(
    password,
    user ? String(user.password_hash) : undefined,
  );
  if (!valid || !user || user.disabled_at) {
    recordFailure(keys);
    auditEvent(
      "auth.login_failed",
      "account",
      null,
      {},
      user
        ? {
            ...identity,
            userId: String(user.id),
            workspaceId: accountWorkspace(String(user.id)),
          }
        : identity,
    );
    throw new HttpError(
      401,
      "Unable to sign in. Check your email and password.",
    );
  }
  clearAccountThrottle(email);
  const session = createSession(String(user.id), request, cookieToken(request));
  auditEvent(
    "auth.signed_in",
    "session",
    session.id,
    {},
    {
      userId: String(user.id),
      workspaceId: accountWorkspace(String(user.id)),
      ...identity,
    },
  );
  return session;
}
export function signOut(): void {
  const context = currentContext();
  if (context.sessionId)
    getDatabase()
      .prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
      .run(context.sessionId, context.user.id);
  auditEvent("auth.signed_out", "session", context.sessionId);
}
export function verifyEmail(token: string): void {
  const db = getDatabase();
  const userId = withTransaction(db, () => {
    const consumed = consumeEmailToken(token, "verify");
    if (
      !consumed.userId ||
      !db
        .prepare("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL")
        .get(consumed.userId)
    )
      throw new HttpError(
        400,
        "This link is invalid, expired, or already used.",
      );
    db.prepare(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?",
    ).run(new Date().toISOString(), consumed.userId);
    return consumed.userId;
  });
  auditEvent(
    "account.email_verified",
    "user",
    userId,
    {},
    { userId, workspaceId: accountWorkspace(userId) },
  );
}
export async function sendRecovery(
  emailInput: string,
  purpose: "verify" | "reset",
  request: Request,
  sender: EmailSender = defaultEmailSender,
): Promise<void> {
  assertEmailConfiguration();
  const email = emailInput.trim().toLowerCase(),
    keys = [
      `email:${requestIdentity(request).ip}`,
      `email:${tokenHash(email)}`,
    ];
  checkThrottle(keys);
  recordFailure(keys);
  const db = getDatabase(),
    user = db
      .prepare(
        "SELECT id,email_verified_at FROM users WHERE email=? AND disabled_at IS NULL",
      )
      .get(email);
  if (!user || (purpose === "verify" && user.email_verified_at)) return;
  const issued = withTransaction(db, () => {
    db.prepare(
      "UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose=? AND used_at IS NULL",
    ).run(new Date().toISOString(), user.id, purpose);
    return issueEmailToken(String(user.id), purpose);
  });
  try {
    await sendAccountEmail(emailTemplate(email, purpose, issued.token), sender);
  } catch (error) {
    db.prepare("DELETE FROM email_tokens WHERE id=?").run(issued.id);
    throw error;
  }
}
export async function resetPassword(
  token: string,
  password: string,
): Promise<void> {
  // Validate/derive before consumption so validation failures never burn the link.
  const passwordHash = await hashPassword(password),
    db = getDatabase();
  const userId = withTransaction(db, () => {
    const consumed = consumeEmailToken(token, "reset");
    if (
      !consumed.userId ||
      !db
        .prepare("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL")
        .get(consumed.userId)
    )
      throw new HttpError(
        400,
        "This link is invalid, expired, or already used.",
      );
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
      passwordHash,
      consumed.userId,
    );
    revokeSessions(consumed.userId);
    db.prepare(
      "UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose='reset' AND used_at IS NULL",
    ).run(new Date().toISOString(), consumed.userId);
    return consumed.userId;
  });
  auditEvent(
    "account.password_reset",
    "user",
    userId,
    {},
    { userId, workspaceId: accountWorkspace(userId) },
  );
}
async function confirmPassword(password: string): Promise<void> {
  const context = currentContext();
  if (context.local)
    throw new HttpError(409, "Account security is unavailable in local mode.");
  const keys = throttleKeys(context.user.email, context.ip);
  checkThrottle(keys);
  const row = getDatabase()
    .prepare(
      "SELECT password_hash FROM users WHERE id=? AND disabled_at IS NULL",
    )
    .get(context.user.id);
  if (
    !(await verifyPassword(
      password,
      row ? String(row.password_hash) : undefined,
    ))
  ) {
    recordFailure(keys);
    throw new HttpError(400, "The password could not be confirmed.");
  }
}
export async function changePassword(
  currentPassword: string,
  password: string,
): Promise<void> {
  await confirmPassword(currentPassword);
  const passwordHash = await hashPassword(password),
    context = currentContext(),
    db = getDatabase();
  withTransaction(db, () => {
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(
      passwordHash,
      context.user.id,
    );
    revokeSessions(context.user.id);
    db.prepare(
      "UPDATE email_tokens SET used_at=? WHERE user_id=? AND purpose='reset' AND used_at IS NULL",
    ).run(new Date().toISOString(), context.user.id);
  });
  auditEvent("account.password_changed", "user", context.user.id);
}
export function accountDetails() {
  const context = currentContext();
  return {
    user: context.user,
    local: context.local,
    sessions: context.local
      ? []
      : getDatabase()
          .prepare(
            "SELECT id,ip,user_agent AS userAgent,created_at AS createdAt,expires_at AS expiresAt FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC",
          )
          .all(context.user.id, new Date().toISOString())
          .map((row) => ({ ...row, current: row.id === context.sessionId })),
  };
}
export function updateProfile(name: string): void {
  const context = currentContext();
  name = nameSchema.parse(name);
  if (!context.local)
    getDatabase()
      .prepare("UPDATE users SET name=? WHERE id=?")
      .run(name, context.user.id);
}
export function signOutEverywhere(): void {
  const context = currentContext();
  revokeSessions(context.user.id);
  auditEvent("auth.sessions_revoked", "user", context.user.id);
}
export function revokeSession(id: string): void {
  const context = currentContext(),
    result = getDatabase()
      .prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
      .run(id, context.user.id);
  if (!result.changes) throw new HttpError(404, "Session not found.");
  auditEvent("auth.session_revoked", "session", id);
}
export async function deleteAccount(
  password: string,
  deleteSoleOwnedWorkspaces: boolean,
): Promise<void> {
  await confirmPassword(password);
  const context = currentContext(),
    db = getDatabase();
  withTransaction(db, () => {
    const memberships = db
      .prepare(
        "SELECT m.workspace_id, (SELECT COUNT(*) FROM memberships m2 WHERE m2.workspace_id=m.workspace_id AND m2.role='owner') AS owners,(SELECT COUNT(*) FROM memberships m3 WHERE m3.workspace_id=m.workspace_id) AS members FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.role='owner' AND w.deleted_at IS NULL",
      )
      .all(context.user.id);
    for (const membership of memberships) {
      if (Number(membership.owners) > 1) continue;
      if (Number(membership.members) > 1)
        throw new HttpError(
          409,
          "Transfer ownership of shared workspaces before deleting your account.",
        );
      if (!deleteSoleOwnedWorkspaces)
        throw new HttpError(
          409,
          "Confirm deletion of workspaces where you are the only member.",
        );
      db.prepare("UPDATE workspaces SET deleted_at=? WHERE id=?").run(
        new Date().toISOString(),
        membership.workspace_id,
      );
    }
    auditEvent("account.deleted", "user", context.user.id);
    revokeSessions(context.user.id);
    db.prepare("DELETE FROM email_tokens WHERE user_id=?").run(context.user.id);
    db.prepare("DELETE FROM memberships WHERE user_id=?").run(context.user.id);
    db.prepare(
      "UPDATE users SET disabled_at=?,email=?,name='Deleted account',password_hash='' WHERE id=?",
    ).run(
      new Date().toISOString(),
      `deleted-${context.user.id}@invalid.local`,
      context.user.id,
    );
  });
}
