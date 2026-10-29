import { withUserRoute } from "@/lib/auth/guards";
import { switchWorkspace } from "@/lib/auth/workspaces";
export const POST = withUserRoute(
  async (
    _request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => {
    switchWorkspace((await context.params).workspaceId);
    return Response.json({ success: true });
  },
);
