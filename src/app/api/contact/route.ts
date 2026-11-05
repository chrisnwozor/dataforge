import { CONTACT_MESSAGES } from "@/content/contact";
import { getContactEnvironment, ContactConfigurationError } from "@/lib/env";
import { contactSchema } from "@/lib/contact/schema";
import { contactProtection } from "@/lib/contact/protection";
import { sendContactEmail } from "@/lib/contact/email";
import { verifyTurnstile } from "@/lib/contact/turnstile";
import {
  ContactBodyError,
  isSameOrigin,
  issueSubmissionToken,
  MINIMUM_SUBMIT_MS,
  readContactBody,
  requestIdentity,
  verifySubmissionToken,
} from "@/lib/contact/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function accepted(development = false) {
  return json({
    ok: true,
    message: development ? CONTACT_MESSAGES.development : CONTACT_MESSAGES.success,
    ...(development ? { development: true, devMode: true } : {}),
  });
}

function safeFailure(error: unknown) {
  // Event codes and configuration names only. Never log request bodies, identities or provider responses.
  if (error instanceof ContactConfigurationError)
    console.error("[contact] configuration unavailable:", error.keys.join(", "));
  else console.error("[contact] request could not be completed.");
  return json({ ok: false, message: CONTACT_MESSAGES.unavailable }, 503);
}

export async function GET(request: Request) {
  try {
    const env = getContactEnvironment();
    if (!isSameOrigin(request, env.siteUrl, false, env.mode === "development"))
      return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 403);
    const identity = requestIdentity(request, env);
    const rate = await contactProtection(env).limit("token", identity);
    if (!rate.success)
      return json({ ok: false, message: CONTACT_MESSAGES.rateLimited }, 429, {
        "Retry-After": String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))),
      });
    return json({
      token: issueSubmissionToken(env.tokenSecret, identity),
      minimumSubmitMs: MINIMUM_SUBMIT_MS,
    });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const env = getContactEnvironment();
    if (!isSameOrigin(request, env.siteUrl, true, env.mode === "development"))
      return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 403);
    const identity = requestIdentity(request, env);
    const protection = contactProtection(env);
    const rate = await protection.limit("submission", identity);
    if (!rate.success)
      return json({ ok: false, message: CONTACT_MESSAGES.rateLimited }, 429, {
        "Retry-After": String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000))),
      });
    const body = await readContactBody(request);
    const development = env.mode !== "production" && !env.delivery;
    if (
      body &&
      typeof body === "object" &&
      "website" in body &&
      typeof body.website === "string" &&
      body.website.trim()
    )
      return accepted(development);
    const result = contactSchema.safeParse(body);
    if (!result.success) return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 400);
    const values = result.data;
    const token = verifySubmissionToken(values.submissionToken, env.tokenSecret, identity);
    if (!token.valid) return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 400);
    if (!(await verifyTurnstile(values.turnstileToken, request, env)))
      return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 400);
    if (!(await protection.consume(token.nonce)))
      return json({ ok: false, message: CONTACT_MESSAGES.invalid }, 409);
    const outcome = await sendContactEmail(values, env, token.nonce);
    return accepted(outcome === "development");
  } catch (error) {
    if (error instanceof ContactBodyError)
      return json({ ok: false, message: CONTACT_MESSAGES.invalid }, error.status);
    return safeFailure(error);
  }
}
