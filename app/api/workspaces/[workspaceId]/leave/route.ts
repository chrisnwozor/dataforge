import { withUserRoute } from "@/lib/auth/guards";
import { leaveWorkspace } from "@/lib/auth/workspaces";
export const POST = withUserRoute(
  async (
    _request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => {
    leaveWorkspace((await context.params).workspaceId);
    return Response.json({ success: true });
  },
);
