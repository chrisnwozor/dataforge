import { getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import {
  authContext,
  localMode,
  requireProjectAccess,
  type AuthContext,
} from "./context";
/** Schedules are authorized as their saved creator, never as a global service owner. */
export function scheduledContext(scheduleId: string): AuthContext | null {
  if (localMode()) return null;
  const row = getDatabase()
    .prepare(
      `SELECT s.workspace_id AS workspaceId,s.created_by AS userId,u.email,u.name,u.email_verified_at AS verifiedAt FROM report_schedules s JOIN workspaces w ON w.id=s.workspace_id JOIN users u ON u.id=s.created_by JOIN memberships m ON m.workspace_id=s.workspace_id AND m.user_id=u.id WHERE s.id=? AND w.deleted_at IS NULL AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND m.role IN ('admin','owner')`,
    )
    .get(scheduleId);
  if (!row)
    throw new HttpError(
      404,
      "The schedule's workspace or administrator is no longer active.",
    );
  return {
    user: {
      id: String(row.userId),
      email: String(row.email),
      name: String(row.name),
      emailVerifiedAt: String(row.verifiedAt),
    },
    workspaceId: String(row.workspaceId),
    sessionId: null,
    ip: "background",
    userAgent: "DataForge report scheduler",
    local: false,
  };
}
export function runScheduledContext<T>(
  scheduleId: string,
  projectId: string,
  callback: () => T,
): T {
  const context = scheduledContext(scheduleId);
  if (!context) return callback();
  return authContext.run(context, () => {
    requireProjectAccess(projectId, "admin");
    return callback();
  });
}
