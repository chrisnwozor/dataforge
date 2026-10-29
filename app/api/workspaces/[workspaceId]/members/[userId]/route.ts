import { withUserRoute, requireWorkspaceRole } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import { changeMember } from "@/lib/auth/workspaces";
import { z } from "zod";
type Context = { params: Promise<{ workspaceId: string; userId: string }> };
export const PUT = withUserRoute(async (request: Request, context: Context) => {
  const { workspaceId, userId } = await context.params;
  requireWorkspaceRole(workspaceId, "admin");
  const body = z
    .object({ role: z.enum(["viewer", "editor", "admin", "owner"]) })
    .strict()
    .parse(await readAuthBody(request));
  changeMember(workspaceId, userId, body.role);
  return Response.json({ success: true });
});
export const DELETE = withUserRoute(
  async (_request: Request, context: Context) => {
    const { workspaceId, userId } = await context.params;
    changeMember(workspaceId, userId, null);
    return Response.json({ success: true });
  },
);
