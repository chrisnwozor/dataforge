import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { tokenHash } from "./tokens";
import type { AuthContext, AuthUser } from "./context";
export const SESSION_COOKIE = "dataforge_session";
export const SESSION_TTL = 14 * 86400_000;
export function cookieToken(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}
export function sessionCookie(
  token: string,
  maxAge = SESSION_TTL / 1000,
): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function requestIdentity(request?: Request): {
  ip: string;
  userAgent: string;
} {
  // Forwarded headers are untrusted unless an operator explicitly configured a trusted reverse proxy.
  const ip =
    process.env.DATAFORGE_TRUST_PROXY === "true"
      ? request?.headers
          .get("x-forwarded-for")
          ?.split(",")[0]
          .trim()
          .slice(0, 64) || "unknown"
      : "direct";
  return {
    ip,
    userAgent: request?.headers.get("user-agent")?.slice(0, 512) || "",
  };
}
export function createSession(
  userId: string,
  request?: Request,
  previousToken?: string,
  now = Date.now(),
): { token: string; id: string } {
  const db = getDatabase();
  if (previousToken)
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      tokenHash(previousToken),
    );
  const user = db
    .prepare("SELECT id FROM users WHERE id = ? AND disabled_at IS NULL")
    .get(userId);
  if (!user) throw new HttpError(401, "Sign in to continue.");
  const workspace = db
    .prepare(
      "SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at,w.id LIMIT 1",
    )
    .get(userId);
  const token = randomBytes(32).toString("base64url"),
    id = randomUUID(),
    identity = requestIdentity(request);
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(
    new Date(now).toISOString(),
  );
  db.prepare(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at,ip,user_agent,created_at,workspace_id) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id,
    userId,
    tokenHash(token),
    new Date(now + SESSION_TTL).toISOString(),
    identity.ip,
    identity.userAgent,
    new Date(now).toISOString(),
    workspace?.workspace_id ?? null,
  );
  // Keep at most 20 devices without exposing tokens to any session-list response.
  db.prepare(
    "DELETE FROM sessions WHERE user_id=? AND id NOT IN (SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20)",
  ).run(userId, userId);
  return { token, id };
}
export function readSession(
  token?: string,
  request?: Request,
  now = Date.now(),
): AuthContext | null {
  if (!token || !/^[\w-]{43}$/.test(token)) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT s.id AS sessionId,s.workspace_id AS workspaceId,u.id,u.email,u.name,u.email_verified_at AS emailVerifiedAt FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`,
    )
    .get(tokenHash(token), new Date(now).toISOString());
  if (!row) return null;
  let workspaceId = row.workspaceId ? String(row.workspaceId) : "";
  if (
    !db
      .prepare(
        "SELECT 1 FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.workspace_id=? AND w.deleted_at IS NULL",
      )
      .get(String(row.id), workspaceId)
  ) {
    workspaceId = String(
      db
        .prepare(
          "SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.deleted_at IS NULL ORDER BY w.created_at,w.id LIMIT 1",
        )
        .get(String(row.id))?.workspace_id ?? "",
    );
  }
  db.prepare("UPDATE sessions SET expires_at=?, workspace_id=? WHERE id=?").run(
    new Date(now + SESSION_TTL).toISOString(),
    workspaceId || null,
    String(row.sessionId),
  );
  const user: AuthUser = {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    emailVerifiedAt: row.emailVerifiedAt ? String(row.emailVerifiedAt) : null,
  };
  return {
    user,
    sessionId: String(row.sessionId),
    workspaceId,
    ...requestIdentity(request),
    local: false,
  };
}
export function revokeSessions(userId: string): void {
  getDatabase().prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
}

/** Long-lived HTTP streams must also stop after device/session revocation. */
export function assertSessionActive(context: AuthContext): void {
  if (context.local || !context.sessionId) return;
  if (
    !getDatabase()
      .prepare(
        "SELECT 1 FROM sessions WHERE id=? AND user_id=? AND expires_at>? ",
      )
      .get(context.sessionId, context.user.id, new Date().toISOString())
  )
    throw new HttpError(401, "Sign in to continue.");
}
