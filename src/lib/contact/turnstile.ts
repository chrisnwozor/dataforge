import type { ContactEnvironment } from "@/lib/env";

export async function verifyTurnstile(token: string, request: Request, env: ContactEnvironment) {
  if (!env.turnstile) return true;
  if (!token) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.turnstile.secret, response: token }),
    signal: AbortSignal.timeout(5000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Contact verification unavailable.");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") return false;
  const verification = result as Record<string, unknown>;
  const expectedHosts = new Set([new URL(request.url).hostname]);
  if (env.siteUrl) expectedHosts.add(new URL(env.siteUrl).hostname);
  return (
    verification.success === true &&
    verification.action === "contact" &&
    typeof verification.hostname === "string" &&
    expectedHosts.has(verification.hostname)
  );
}
