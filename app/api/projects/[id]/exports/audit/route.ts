import { withProjectRoute } from "@/lib/auth/guards";
import { auditEvent } from "@/lib/auth/audit";
import { readAuthBody } from "@/lib/auth/http";
import { z } from "zod";
export const POST = withProjectRoute(
  "viewer",
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const body = z
      .object({ format: z.enum(["png", "svg", "print"]) })
      .strict()
      .parse(await readAuthBody(request));
    auditEvent("export.downloaded", "project", (await context.params).id, {
      format: body.format,
      reason: "client-rendered",
    });
    return Response.json({ success: true });
  },
);
