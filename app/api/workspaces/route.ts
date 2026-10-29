import { withUserRoute } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import {
  createWorkspace,
  listWorkspaces,
  workspaceNameSchema,
} from "@/lib/auth/workspaces";
import { z } from "zod";
export const GET = withUserRoute(async () =>
  Response.json({ workspaces: listWorkspaces() }),
);
export const POST = withUserRoute(async (request: Request) => {
  const body = z
    .object({ name: workspaceNameSchema })
    .strict()
    .parse(await readAuthBody(request));
  return Response.json(createWorkspace(body.name), { status: 201 });
});
