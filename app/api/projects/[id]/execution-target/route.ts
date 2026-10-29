import { withProjectRoute } from "@/lib/auth/guards";
import { readExecutionTarget } from "@/lib/server/connection";
export const GET = withProjectRoute("editor", async () =>
  Response.json({ connection: readExecutionTarget() }),
);
