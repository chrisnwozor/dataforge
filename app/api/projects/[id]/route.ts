import { withProjectRoute } from "@/lib/auth/guards";
import { deleteProject, findProject } from "@/lib/server/projects";
export const GET = withProjectRoute(
  "viewer",
  async (_request: Request, context: { params: Promise<{ id: string }> }) =>
    Response.json({ project: findProject((await context.params).id) }),
);
export const DELETE = withProjectRoute(
  "editor",
  async (_request: Request, context: { params: Promise<{ id: string }> }) => {
    await deleteProject((await context.params).id);
    return new Response(null, { status: 204 });
  },
);
