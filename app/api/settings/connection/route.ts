import {
  readPublicConnection,
  readConnectionRequest,
  saveConnection,
} from "@/lib/server/connection";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return Response.json(
      { connection: readPublicConnection() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Connection settings could not be loaded.");
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    return Response.json(
      { connection: saveConnection(await readConnectionRequest(request)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Connection settings could not be saved.");
  }
}
