import { currentContext } from "@/lib/auth/context";
import { sessionCookie } from "@/lib/auth/sessions";
import { withUserRoute } from "@/lib/auth/guards";
import { revokeSession } from "@/lib/auth/accounts";
export const DELETE = withUserRoute(
  async (
    _request: Request,
    context: { params: Promise<{ sessionId: string }> },
  ) => {
    const { sessionId } = await context.params;
    revokeSession(sessionId);
    return Response.json(
      { success: true },
      {
        headers:
          sessionId === currentContext().sessionId
            ? { "Set-Cookie": sessionCookie("", 0) }
            : undefined,
      },
    );
  },
  true,
);
