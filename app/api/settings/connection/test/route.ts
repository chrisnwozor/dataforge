import { readConnectionRequest, testConnection } from "@/lib/server/connection";
import { errorResponse } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return Response.json(
      await testConnection(await readConnectionRequest(request)),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(
      error,
      "The connection could not be tested. Check SQL Server's configuration.",
    );
  }
}
