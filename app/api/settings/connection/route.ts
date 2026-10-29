import { withWorkspaceRoute } from "@/lib/auth/guards";
import {
  readPublicConnection,
  readConnectionRequest,
  saveConnection,
} from "@/lib/server/connection";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  try {
    return Response.json(
      { connection: readPublicConnection() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Connection settings could not be loaded.");
  }
}

async function handlePUT(request: Request): Promise<Response> {
  try {
    return Response.json(
      { connection: saveConnection(await readConnectionRequest(request)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Connection settings could not be saved.");
  }
}

export const GET = withWorkspaceRoute("admin", handleGET);
export const PUT = withWorkspaceRoute("admin", handlePUT);
