import { AsyncLocalStorage } from "node:async_hooks";
import { getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import { LOCAL_WORKSPACE_ID } from "./migrations";

export type Role = "viewer" | "editor" | "admin" | "owner";
export const roles: Role[] = ["viewer", "editor", "admin", "owner"];
export const actions = {
  read: "viewer",
  query: "viewer",
  edit: "editor",
  run: "editor",
  connections: "admin",
  members: "admin",
  schedules: "admin",
  activity: "admin",
  deleteWorkspace: "owner",
  transferOwnership: "owner",
} as const;
export function roleAllows(role: Role, action: keyof typeof actions): boolean {
  return roles.indexOf(role) >= roles.indexOf(actions[action]);
}
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: string | null;
}
export interface AuthContext {
  user: AuthUser;
  sessionId: string | null;
  workspaceId: string;
  ip: string;
  userAgent: string;
  local: boolean;
}
const globalAuth = globalThis as typeof globalThis & {
  dataforgeAuthContext?: AsyncLocalStorage<AuthContext>;
};
export const authContext = (globalAuth.dataforgeAuthContext ??=
  new AsyncLocalStorage<AuthContext>());
export function localMode(): boolean {
  return process.env.DATAFORGE_AUTH === "off";
}
export function localContext(): AuthContext {
  return {
    user: {
      id: "local",
      email: "local@localhost",
      name: "Local user",
      emailVerifiedAt: new Date(0).toISOString(),
    },
    sessionId: null,
    workspaceId: LOCAL_WORKSPACE_ID,
    ip: "local",
    userAgent: "local",
    local: true,
  };
}
export function currentContext(): AuthContext {
  const context = authContext.getStore();
  if (context && (!context.local || localMode())) return context;
  if (localMode()) return localContext();
  throw new HttpError(401, "Sign in to continue.");
}
export function requireWorkspaceRole(
  workspaceId: string,
  minRole: Role = "viewer",
): { workspaceId: string; role: Role } {
  const context = currentContext();
  if (context.local) {
    if (workspaceId !== LOCAL_WORKSPACE_ID)
      throw new HttpError(404, "Workspace not found.");
    return { workspaceId, role: "owner" };
  }
  const row = getDatabase()
    .prepare(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ? AND u.disabled_at IS NULL AND w.deleted_at IS NULL`,
    )
    .get(workspaceId, context.user.id);
  if (!row) throw new HttpError(404, "Workspace not found.");
  const role = row.role as Role;
  if (roles.indexOf(role) < roles.indexOf(minRole))
    throw new HttpError(403, "Your workspace role does not allow this action.");
  return { workspaceId, role };
}
export function currentWorkspaceId(minRole: Role = "viewer"): string {
  const context = currentContext();
  requireWorkspaceRole(context.workspaceId, minRole);
  return context.workspaceId;
}
export function requireProjectAccess(
  projectId: string,
  minRole: Role = "viewer",
): { workspaceId: string; role: Role } {
  const context = currentContext();
  const terminal = bookkeeping.getStore();
  if (
    terminal?.projectId === projectId &&
    terminal.workspaceId === context.workspaceId
  ) {
    if (roles.indexOf(minRole) > roles.indexOf(terminal.maxRole))
      throw new HttpError(403, "Job bookkeeping cannot elevate permissions.");
    return { workspaceId: terminal.workspaceId, role: terminal.maxRole };
  }
  const row = getDatabase()
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .get(projectId);
  if (!row) throw new HttpError(404, "Project not found.");
  let access: { workspaceId: string; role: Role };
  try {
    access = requireWorkspaceRole(String(row.workspace_id), minRole);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404)
      throw new HttpError(404, "Project not found.");
    throw error;
  }
  if (context.sessionId && context.workspaceId !== access.workspaceId)
    getDatabase()
      .prepare("UPDATE sessions SET workspace_id=? WHERE id=? AND user_id=?")
      .run(access.workspaceId, context.sessionId, context.user.id);
  context.workspaceId = access.workspaceId;
  return access;
}
/** New uploads have no project record yet; the boundary guard already authorized the workspace. */
export function requireProjectFileAccess(projectId: string): string {
  const row = getDatabase()
    .prepare("SELECT workspace_id FROM projects WHERE id = ?")
    .get(projectId);
  if (row) return requireProjectAccess(projectId).workspaceId;
  return currentWorkspaceId("editor");
}
export function assertActiveJob(
  workspaceId = currentContext().workspaceId,
  minRole: Role = "viewer",
): void {
  requireWorkspaceRole(workspaceId, minRole);
}
export function captureJobContext(): AuthContext {
  return { ...currentContext(), user: { ...currentContext().user } };
}

const bookkeeping = new AsyncLocalStorage<{
  projectId: string;
  workspaceId: string;
  maxRole: Role;
}>();
/** Captured by trusted job starters only. Cleanup can record a terminal state after
 * membership revocation; this capability is never accepted from an HTTP request. */
export function createJobAccess(projectId: string, minRole: Role = "viewer") {
  const access = localMode()
    ? { workspaceId: currentContext().workspaceId }
    : requireProjectAccess(projectId, minRole);
  const context = captureJobContext();
  return {
    workspaceId: access.workspaceId,
    userId: context.user.id,
    run<T>(callback: () => T): T {
      return authContext.run({ ...context }, callback);
    },
    assert(): void {
      authContext.run({ ...context }, () => {
        if (!localMode()) requireProjectAccess(projectId, minRole);
      });
    },
    watch(controller: AbortController, cancel?: () => void): () => void {
      if (context.local) return () => {};
      const timer = setInterval(() => {
        if (controller.signal.aborted) return;
        try {
          authContext.run({ ...context }, () =>
            requireProjectAccess(projectId, minRole),
          );
        } catch {
          clearInterval(timer);
          controller.abort(
            new Error("Workspace access changed. This job was cancelled."),
          );
          try {
            cancel?.();
          } catch {
            /* The job still closes its connection in finally. */
          }
        }
      }, 250);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    finish<T>(callback: () => T): T {
      return authContext.run({ ...context }, () =>
        bookkeeping.run(
          { projectId, workspaceId: access.workspaceId, maxRole: minRole },
          callback,
        ),
      );
    },
  };
}
