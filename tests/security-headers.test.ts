import { expect, it } from "vitest";
import { contentSecurityPolicy, staticSecurityHeaders } from "@/lib/security-headers";
it("uses a per-response nonce without unsafe script execution in production", () => {
  const csp = contentSecurityPolicy("test-nonce", {
    development: false,
    turnstile: false,
    https: true,
  });
  expect(csp).toContain("'nonce-test-nonce'");
  expect(csp).toContain("'strict-dynamic'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp.split(";").find((v) => v.trim().startsWith("script-src"))).not.toContain(
    "'unsafe-inline'",
  );
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("upgrade-insecure-requests");
  expect(csp).toContain("frame-src 'none'");
});
it("allows the optional challenge origin only when used and keeps localhost previews on HTTP", () => {
  const base = { development: false, https: false };
  expect(contentSecurityPolicy("a", { ...base, turnstile: false })).not.toContain("cloudflare");
  const configured = contentSecurityPolicy("b", { ...base, turnstile: true });
  expect(configured).toContain("https://challenges.cloudflare.com");
  expect(configured).not.toContain("upgrade-insecure-requests");
});
it("provides MIME, framing, referrer and permissions protection", () => {
  expect(staticSecurityHeaders.map((v) => v.key).sort()).toEqual([
    "Permissions-Policy",
    "Referrer-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
  ]);
});
