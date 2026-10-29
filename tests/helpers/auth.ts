import { randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/server/db";
import { authContext, type AuthContext, type Role } from "@/lib/auth/context";
import { createSession } from "@/lib/auth/sessions";
export function userFixture(
  email = `${randomUUID()}@example.test`,
  verified = true,
): string {
  const id = randomUUID();
  getDatabase()
    .prepare(
      "INSERT INTO users(id,email,password_hash,email_verified_at,name,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      id,
      email,
      "test-hash",
      verified ? new Date().toISOString() : null,
      email.split("@")[0],
      new Date().toISOString(),
    );
  return id;
}
export function workspaceFixture(owner: string, name = "Workspace"): string {
  const id = randomUUID(),
    db = getDatabase();
  db.prepare(
    "INSERT INTO workspaces(id,name,slug,created_by,created_at) VALUES(?,?,?,?,?)",
  ).run(id, name, `workspace-${id}`, owner, new Date().toISOString());
  memberFixture(id, owner, "owner");
  return id;
}
export function memberFixture(
  workspaceId: string,
  userId: string,
  role: Role,
): void {
  getDatabase()
    .prepare(
      "INSERT INTO memberships(workspace_id,user_id,role) VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role",
    )
    .run(workspaceId, userId, role);
}
export function contextFixture(
  userId: string,
  workspaceId: string,
): AuthContext {
  const row = getDatabase()
    .prepare("SELECT email,name,email_verified_at FROM users WHERE id=?")
    .get(userId)!;
  return {
    user: {
      id: userId,
      email: String(row.email),
      name: String(row.name),
      emailVerifiedAt: row.email_verified_at
        ? String(row.email_verified_at)
        : null,
    },
    sessionId: null,
    workspaceId,
    ip: "127.0.0.1",
    userAgent: "Vitest",
    local: false,
  };
}
export function asUser<T>(
  userId: string,
  workspaceId: string,
  callback: () => T,
): T {
  return authContext.run(contextFixture(userId, workspaceId), callback);
}
export function projectFixture(workspaceId: string): string {
  const id = randomUUID(),
    now = new Date().toISOString();
  getDatabase()
    .prepare(
      "INSERT INTO projects(id,workspace_id,name,source_file,source_type,status,row_count,column_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      workspaceId,
      "Tenant project",
      "sales.csv",
      "CSV",
      "Ready",
      2,
      2,
      now,
      now,
    );
  return id;
}
export function authRequest(
  userId: string,
  path: string,
  method = "GET",
  body?: unknown,
): Request {
  const session = createSession(userId);
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      Cookie: `dataforge_session=${session.token}`,
      Origin: "http://localhost",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
