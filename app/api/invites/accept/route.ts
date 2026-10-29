import { withUserRoute } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import { acceptInvite } from "@/lib/auth/workspaces";
import { z } from "zod";
export const POST = withUserRoute(
  async (request: Request) =>
    Response.json({
      workspaceId: acceptInvite(
        z
          .object({ token: z.string().max(128) })
          .strict()
          .parse(await readAuthBody(request)).token,
      ),
    }),
  true,
);
