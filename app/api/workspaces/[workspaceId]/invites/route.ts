import { withUserRoute, requireWorkspaceRole } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import { inviteMember } from "@/lib/auth/workspaces";
import { z } from "zod";
export const POST = withUserRoute(
  async (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => {
    const { workspaceId } = await context.params;
    requireWorkspaceRole(workspaceId, "admin");
    const body = z
      .object({
        email: z.email().max(254),
        role: z.enum(["viewer", "editor", "admin"]),
      })
      .strict()
      .parse(await readAuthBody(request));
    await inviteMember(workspaceId, body.email, body.role);
    return Response.json({ message: "Invitation sent." });
  },
);
