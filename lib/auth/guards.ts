import { ZodError } from "zod";
import type { ReactNode } from "react";
import { getDatabase } from "@/lib/server/db";
import { errorResponse, HttpError } from "@/lib/server/http";
import {
  authContext,
  currentContext,
  currentWorkspaceId,
  localContext,
  localMode,
  requireProjectAccess,
  type AuthContext,
  type Role,
} from "./context";
import {
  cookieToken,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./sessions";
import { auditEvent } from "./audit";
export { requireProjectAccess, requireWorkspaceRole } from "./context";

export async function requireUser(
  request?: Request,
  allowUnverified = false,
): Promise<AuthContext> {
  let context = authContext.getStore();
  if (!context) {
    if (localMode()) context = localContext();
    else if (request)
      context = readSession(cookieToken(request), request) ?? undefined;
    else {
      const { cookies } = await import("next/headers");
      context =
        readSession((await cookies()).get(SESSION_COOKIE)?.value) ?? undefined;
    }
  }
  if (!context) throw new HttpError(401, "Sign in to continue.");
  if (!context.local) {
    if (
      !getDatabase()
        .prepare("SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL")
        .get(context.user.id)
    )
      throw new HttpError(401, "Sign in to continue.");
    if (!allowUnverified && !context.user.emailVerifiedAt)
      throw new HttpError(403, "Verify your email address to continue.");
  }
  return context;
}
export function checkOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "This request must come from DataForge.");
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.DATAFORGE_APP_URL || request.url).origin;
  if (origin && origin !== expected)
    throw new HttpError(403, "This request must come from DataForge.");
  if (!origin && cookieToken(request) && !authContext.getStore())
    throw new HttpError(403, "An Origin header is required for this request.");
}
function guardedError(error: unknown, fallback: string): Response {
  const response = errorResponse(error, fallback);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

type Handler = (...args: never[]) => Promise<Response>;
function protectedRoute<T extends Handler>(
  handler: T,
  authorize: (args: Parameters<T>) => Promise<void>,
  unverified = false,
): T {
  return (async (...args: Parameters<T>) => {
    try {
      const request =
        (args as unknown[])[0] instanceof Request
          ? ((args as unknown[])[0] as Request)
          : undefined;
      if (request) checkOrigin(request);
      const context = await requireUser(request, unverified);
      return await authContext.run(
        { ...context, user: { ...context.user } },
        async () => {
          await authorize(args);
          const response = (await Reflect.apply(
            handler,
            undefined,
            args,
          )) as Response;
          response.headers.set("Cache-Control", "no-store");
          response.headers.set("X-Content-Type-Options", "nosniff");
          const token = request ? cookieToken(request) : undefined;
          if (
            token &&
            response.status < 400 &&
            !response.headers.has("set-cookie")
          )
            response.headers.append("Set-Cookie", sessionCookie(token));
          return response;
        },
      );
    } catch (error) {
      return guardedError(
        error instanceof ZodError
          ? new HttpError(400, error.issues[0]?.message ?? "Check your input.")
          : error,
        "The request could not be completed.",
      );
    }
  }) as T;
}
export function withUserRoute<T extends Handler>(
  handler: T,
  allowUnverified = false,
): T {
  return protectedRoute(handler, async () => {}, allowUnverified);
}
export function withWorkspaceRoute<T extends Handler>(
  role: Role,
  handler: T,
): T {
  return protectedRoute(handler, async () => {
    currentWorkspaceId(role);
  });
}
export function withProjectRoute<T extends Handler>(role: Role, handler: T): T {
  const audited = (async (...args: Parameters<T>) => {
    const context = args[1] as {
      params: Promise<{
        id: string;
        dashboardId?: string;
        reportId?: string;
        runId?: string;
      }>;
    };
    const params = await context.params;
    if (!localMode()) requireProjectAccess(params.id, role);
    const response = (await Reflect.apply(
      handler,
      undefined,
      args,
    )) as Response;
    if (response.status < 400) {
      if (response.headers.get("content-disposition")?.includes("attachment"))
        auditEvent("export.downloaded", "project", params.id, {
          format: response.headers.get("content-type")?.split(";")[0] ?? "file",
        });
    }
    return response;
  }) as T;
  return protectedRoute(audited, async () => {});
}
/** Explicit public routes still enforce origin checks, bounded callers, and no-store. */
export function publicRoute<T extends Handler>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    try {
      if ((args as unknown[])[0] instanceof Request)
        checkOrigin((args as unknown[])[0] as Request);
      const response = (await Reflect.apply(
        handler,
        undefined,
        args,
      )) as Response;
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    } catch (error) {
      return guardedError(
        error instanceof ZodError
          ? new HttpError(400, error.issues[0]?.message ?? "Check your input.")
          : error,
        "The request could not be completed.",
      );
    }
  }) as T;
}
async function pageFailure(error: unknown): Promise<never> {
  const { notFound, redirect } = await import("next/navigation");
  if (error instanceof HttpError) {
    if (error.status === 401) redirect("/sign-in");
    if (error.status === 403 && /Verify/.test(error.message))
      redirect("/verify");
    if (error.status === 403 || error.status === 404) notFound();
  }
  throw error;
}
export function withUserPage<P>(
  page: (props: P) => ReactNode | Promise<ReactNode>,
  allowUnverified = false,
): (props: P) => Promise<ReactNode> {
  return async (props) => {
    try {
      const context = await requireUser(undefined, allowUnverified);
      return await authContext.run({ ...context }, () => page(props));
    } catch (error) {
      return pageFailure(error);
    }
  };
}
export function withWorkspacePage<P>(
  role: Role,
  page: (props: P) => ReactNode | Promise<ReactNode>,
): (props: P) => Promise<ReactNode> {
  return withUserPage(async (props) => {
    if (!currentContext().workspaceId) {
      const { redirect } = await import("next/navigation");
      redirect("/workspaces");
    }
    currentWorkspaceId(role);
    return page(props);
  });
}
export function withProjectPage<P extends { params: Promise<{ id: string }> }>(
  role: Role,
  page: (props: P) => ReactNode | Promise<ReactNode>,
): (props: P) => Promise<ReactNode> {
  return withUserPage(async (props) => {
    const { id } = await props.params;
    requireProjectAccess(id, role);
    return page(props);
  });
}
/** Used only by explicit public authentication pages, checked by the route inventory. */
export function publicPage<P>(
  page: (props: P) => ReactNode | Promise<ReactNode>,
): (props: P) => ReactNode | Promise<ReactNode> {
  return page;
}
export function scopedResourceProject(
  table:
    "runs" | "dashboards" | "reports" | "explore_views" | "project_sources",
  id: string,
): string {
  const row = getDatabase()
    .prepare(`SELECT project_id FROM ${table} WHERE id=?`)
    .get(id);
  if (!row) throw new HttpError(404, "Resource not found.");
  requireProjectAccess(String(row.project_id));
  return String(row.project_id);
}
// Keep a synchronous guard available for non-HTTP resource helpers and background callbacks.
export function requireActiveContext(): AuthContext {
  const context = currentContext();
  currentWorkspaceId();
  return context;
}
