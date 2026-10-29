import { withUserRoute, requireWorkspaceRole } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import { transferOwnership } from "@/lib/auth/workspaces";
import { z } from "zod";
export const POST = withUserRoute(
  async (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => {
    const { workspaceId } = await context.params;
    requireWorkspaceRole(workspaceId, "owner");
    transferOwnership(
      workspaceId,
      z
        .object({ userId: z.string().uuid() })
        .strict()
        .parse(await readAuthBody(request)).userId,
    );
    return Response.json({ success: true });
  },
);
