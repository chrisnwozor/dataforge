import { z } from "zod";
import { boundedBody, errorResponse, HttpError } from "@/lib/server/http";
import * as accounts from "./accounts";
import { authContext, localContext, localMode } from "./context";
import { cookieToken, readSession, sessionCookie } from "./sessions";
import { listWorkspaces } from "./workspaces";
export async function readAuthBody(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Send JSON.");
  try {
    return await new Response(await boundedBody(request, 16 * 1024)).json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Send valid JSON.");
  }
}
export function authEndpoint(
  action: string,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const body =
        action === "sign-out" || action === "sign-out-everywhere"
          ? {}
          : await readAuthBody(request);
      switch (action) {
        case "sign-up":
          await accounts.signUp(body, request);
          return Response.json({
            message:
              "If this address can be registered, a verification link has been sent. Check your email.",
          });
        case "sign-in": {
          const data = z
            .object({
              email: z.string().max(254),
              password: z.string().max(1024),
            })
            .strict()
            .parse(body);
          const session = await accounts.signIn(
              data.email,
              data.password,
              request,
            ),
            context = readSession(session.token, request)!;
          return Response.json(
            {
              user: context.user,
              next: context.user.emailVerifiedAt ? "/projects" : "/verify",
            },
            { headers: { "Set-Cookie": sessionCookie(session.token) } },
          );
        }
        case "verify":
          accounts.verifyEmail(
            z
              .object({ token: z.string().max(128) })
              .strict()
              .parse(body).token,
          );
          return Response.json({ message: "Email verified. You can sign in." });
        case "forgot-password":
        case "resend-verification": {
          const data = z
            .object({ email: z.string().trim().pipe(z.email().max(254)) })
            .strict()
            .parse(body);
          await accounts.sendRecovery(
            data.email,
            action === "forgot-password" ? "reset" : "verify",
            request,
          );
          return Response.json({
            message:
              "If this address is eligible, an email has been sent. Check your inbox.",
          });
        }
        case "reset-password": {
          const data = z
            .object({
              token: z.string().max(128),
              password: z.string().min(12).max(1024),
            })
            .strict()
            .parse(body);
          await accounts.resetPassword(data.token, data.password);
          return Response.json(
            { message: "Password reset. Sign in with your new password." },
            { headers: { "Set-Cookie": sessionCookie("", 0) } },
          );
        }
        case "change-password": {
          const data = z
            .object({
              currentPassword: z.string().max(1024),
              password: z.string().min(12).max(1024),
            })
            .strict()
            .parse(body);
          await accounts.changePassword(data.currentPassword, data.password);
          return Response.json(
            { message: "Password changed. All sessions have been signed out." },
            { headers: { "Set-Cookie": sessionCookie("", 0) } },
          );
        }
        case "sign-out":
          accounts.signOut();
          return Response.json(
            { success: true },
            { headers: { "Set-Cookie": sessionCookie("", 0) } },
          );
        case "sign-out-everywhere":
          accounts.signOutEverywhere();
          return Response.json(
            { success: true },
            { headers: { "Set-Cookie": sessionCookie("", 0) } },
          );
        case "profile":
          accounts.updateProfile(
            z.object({ name: z.string() }).strict().parse(body).name,
          );
          return Response.json({ success: true });
        case "delete-account": {
          const data = z
            .object({
              password: z.string().max(1024),
              deleteSoleOwnedWorkspaces: z.boolean(),
            })
            .strict()
            .parse(body);
          await accounts.deleteAccount(
            data.password,
            data.deleteSoleOwnedWorkspaces,
          );
          return Response.json(
            { success: true },
            { headers: { "Set-Cookie": sessionCookie("", 0) } },
          );
        }
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      return errorResponse(
        error instanceof z.ZodError
          ? new HttpError(
              400,
              error.issues[0]?.message || "Check your details.",
            )
          : error,
        "The account request could not be completed.",
      );
    }
  };
}
export async function publicIdentity(request: Request): Promise<Response> {
  const context = localMode()
    ? localContext()
    : readSession(cookieToken(request), request);
  if (!context)
    return Response.json({
      user: null,
      workspaces: [],
      workspaceId: null,
      local: false,
    });
  return authContext.run(context, () =>
    Response.json(
      {
        user: context.user,
        workspaces: listWorkspaces(),
        workspaceId: context.workspaceId,
        local: context.local,
      },
      {
        headers:
          !context.local && cookieToken(request)
            ? { "Set-Cookie": sessionCookie(cookieToken(request)!) }
            : undefined,
      },
    ),
  );
}
