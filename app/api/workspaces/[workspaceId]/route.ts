import { withUserRoute, requireWorkspaceRole } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import {
  deleteWorkspace,
  listInvites,
  listMembers,
  renameWorkspace,
  workspaceNameSchema,
} from "@/lib/auth/workspaces";
import { getDatabase } from "@/lib/server/db";
import { z } from "zod";
type Context = { params: Promise<{ workspaceId: string }> };
export const GET = withUserRoute(
  async (_request: Request, context: Context) => {
    const { workspaceId } = await context.params;
    requireWorkspaceRole(workspaceId, "admin");
    return Response.json({
      members: listMembers(workspaceId),
      invites: listInvites(workspaceId),
      retentionDays: getDatabase()
        .prepare("SELECT audit_retention_days FROM workspaces WHERE id=?")
        .get(workspaceId)?.audit_retention_days,
    });
  },
);
export const PUT = withUserRoute(async (request: Request, context: Context) => {
  const { workspaceId } = await context.params;
  requireWorkspaceRole(workspaceId, "admin");
  renameWorkspace(
    workspaceId,
    z
      .object({ name: workspaceNameSchema })
      .strict()
      .parse(await readAuthBody(request)).name,
  );
  return Response.json({ success: true });
});
export const DELETE = withUserRoute(
  async (_request: Request, context: Context) => {
    deleteWorkspace((await context.params).workspaceId);
    return Response.json({ success: true });
  },
);
