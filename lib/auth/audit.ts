import { randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/server/db";
import { authContext, currentWorkspaceId } from "./context";
const allowedMetadata = new Set([
  "role",
  "previousRole",
  "status",
  "success",
  "count",
  "reason",
  "format",
  "retentionDays",
]);
export function auditEvent(
  action: string,
  targetType: string,
  targetId?: string | null,
  metadata: Record<string, unknown> = {},
  identity?: {
    workspaceId?: string | null;
    userId?: string | null;
    ip?: string;
    userAgent?: string;
  },
): void {
  const context = authContext.getStore();
  const safe = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key, value]) =>
        allowedMetadata.has(key) &&
        (typeof value === "boolean" ||
          typeof value === "number" ||
          (typeof value === "string" && value.length <= 120)),
    ),
  );
  getDatabase()
    .prepare(
      "INSERT INTO audit_events(id,workspace_id,user_id,action,target_type,target_id,ip,user_agent,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      identity?.workspaceId ?? (context?.workspaceId || null),
      identity?.userId ?? (context?.local ? null : context?.user.id) ?? null,
      action.slice(0, 100),
      targetType.slice(0, 60),
      targetId ?? null,
      identity?.ip ?? context?.ip ?? "",
      identity?.userAgent ?? context?.userAgent ?? "",
      JSON.stringify(safe),
      new Date().toISOString(),
    );
}
export function readAudit(
  filters: { action?: string; from?: string; to?: string; limit?: number } = {},
) {
  const workspaceId = currentWorkspaceId("admin");
  return getDatabase()
    .prepare(
      `SELECT a.id,a.user_id AS userId,u.name AS userName,a.action,a.target_type AS targetType,a.target_id AS targetId,a.ip,a.user_agent AS userAgent,a.metadata,a.created_at AS createdAt FROM audit_events a LEFT JOIN users u ON u.id=a.user_id WHERE a.workspace_id=? AND (? IS NULL OR a.action=?) AND (? IS NULL OR a.created_at>=?) AND (? IS NULL OR a.created_at<=?) ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,
    )
    .all(
      workspaceId,
      filters.action ?? null,
      filters.action ?? null,
      filters.from ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.to ?? null,
      Math.max(1, Math.min(filters.limit ?? 200, 10000)),
    )
    .map((row) => ({
      id: String(row.id),
      userId: row.userId === null ? null : String(row.userId),
      userName: row.userName === null ? null : String(row.userName),
      action: String(row.action),
      targetType: String(row.targetType),
      targetId: row.targetId === null ? null : String(row.targetId),
      ip: String(row.ip),
      userAgent: String(row.userAgent),
      createdAt: String(row.createdAt),
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
    }));
}
export function pruneAudit(now = Date.now()): number {
  const db = getDatabase();
  let removed = 0;
  for (const row of db
    .prepare("SELECT id,audit_retention_days FROM workspaces")
    .all()) {
    removed += Number(
      db
        .prepare(
          "DELETE FROM audit_events WHERE workspace_id=? AND created_at<?",
        )
        .run(
          row.id,
          new Date(
            now - Number(row.audit_retention_days) * 86400_000,
          ).toISOString(),
        ).changes,
    );
  }
  removed += Number(
    db
      .prepare(
        "DELETE FROM audit_events WHERE workspace_id IS NULL AND created_at<?",
      )
      .run(new Date(now - 365 * 86400_000).toISOString()).changes,
  );
  return removed;
}
