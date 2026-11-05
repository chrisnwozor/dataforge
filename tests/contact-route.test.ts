import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/contact/route";
import { getContactEnvironment } from "@/lib/env";
import { issueSubmissionToken, requestIdentity } from "@/lib/contact/security";

const mocked = vi.hoisted(() => ({
  limit: vi.fn(),
  consume: vi.fn(),
  send: vi.fn(),
  turnstile: vi.fn(),
}));
vi.mock("@/lib/contact/protection", () => ({
  contactProtection: () => ({ limit: mocked.limit, consume: mocked.consume }),
}));
vi.mock("@/lib/contact/email", () => ({ sendContactEmail: mocked.send }));
vi.mock("@/lib/contact/turnstile", () => ({ verifyTurnstile: mocked.turnstile }));

const details = {
  name: "Alex Morgan",
  businessName: "Example business",
  email: "alex@example.test",
  service: "cloud-data-engineering",
  projectDescription: "We need to combine sales and stock reports into one reliable view.",
  consent: true,
  website: "",
  turnstileToken: "",
};

function request(body: unknown = details, headers: Record<string, string> = {}) {
  const preliminary = new Request("https://dataforge.test/api/contact", {
    headers: { origin: "https://dataforge.test", ...headers },
  });
  const env = getContactEnvironment();
  const token = issueSubmissionToken(
    env.tokenSecret,
    requestIdentity(preliminary, env),
    Date.now() - 10000,
  );
  return new Request(preliminary, {
    method: "POST",
    headers: {
      ...Object.fromEntries(preliminary.headers),
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      ...details,
      submissionToken: token,
      ...(typeof body === "object" && body !== null ? body : {}),
    }),
  });
}

function configureProduction() {
  for (const [key, value] of Object.entries({
    NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: "https://dataforge.test",
    RESEND_API_KEY: "mock-api-key",
    CONTACT_TO_EMAIL: "owner@example.test",
    CONTACT_FROM_EMAIL: "inquiries@example.test",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "mock-redis-token",
  }))
    vi.stubEnv(key, value);
}

beforeEach(() => {
  for (const key of [
    "RESEND_API_KEY",
    "CONTACT_TO_EMAIL",
    "CONTACT_FROM_EMAIL",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "TURNSTILE_SECRET_KEY",
    "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    "NEXT_PUBLIC_SITE_URL",
    "VERCEL",
    "CONTACT_TRUST_PROXY",
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CONTACT_TOKEN_SECRET", "test-contact-secret-with-at-least-thirty-two-characters");
  mocked.limit.mockReset().mockResolvedValue({ success: true, reset: Date.now() + 900000 });
  mocked.consume.mockReset().mockResolvedValue(true);
  mocked.send.mockReset().mockResolvedValue("sent");
  mocked.turnstile.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("contact route", () => {
  it("issues an uncached signed token and states the minimum wait", async () => {
    const response = await GET(new Request("https://dataforge.test/api/contact"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      token: expect.any(String),
      minimumSubmitMs: 3000,
    });
    expect(mocked.limit).toHaveBeenCalledWith("token", expect.any(String));
  });

  it("prepares the browser form when Next development uses the wildcard bind address", async () => {
    const response = await GET(
      new Request("http://0.0.0.0:3000/api/contact", {
        headers: { referer: "http://localhost:3000/contact", "sec-fetch-site": "same-origin" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: expect.any(String) });
  });

  it("validates, consumes the nonce and sends normalized inquiry details", async () => {
    const response = await POST(request({ name: "  Alex Morgan  ", email: " ALEX@example.test " }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocked.consume).toHaveBeenCalledOnce();
    expect(mocked.send).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Alex Morgan", email: "alex@example.test" }),
      expect.any(Object),
      expect.any(String),
    );
  });

  it("clearly labels local development no-op success", async () => {
    mocked.send.mockResolvedValue("development");
    const response = await POST(request());
    expect(await response.json()).toMatchObject({
      ok: true,
      development: true,
      devMode: true,
      message: expect.stringContaining("No email was sent"),
    });
  });

  it("returns generic validation and source errors", async () => {
    const invalid = await POST(request({ email: "invalid", consent: false }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      ok: false,
      message: "Please check your details and try again.",
    });
    const foreign = await POST(request(details, { origin: "https://attacker.test" }));
    expect(foreign.status).toBe(403);
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("silently discards the obvious honeypot bot without sending email", async () => {
    const response = await POST(request({ website: "bot-filled" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("returns recoverable errors for forged, expired and premature signed tokens", async () => {
    configureProduction();
    const env = getContactEnvironment();
    const identity = requestIdentity(new Request("https://dataforge.test/api/contact"), env);
    for (const submissionToken of [
      "forged.token",
      issueSubmissionToken(env.tokenSecret, identity, Date.now() - 2 * 60 * 60 * 1000 - 1),
      issueSubmissionToken(env.tokenSecret, identity, Date.now()),
    ]) {
      const response = await POST(request({ submissionToken }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        message: "Please check your details and try again.",
      });
    }
    expect(mocked.consume).not.toHaveBeenCalled();
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("keeps failed Turnstile verification and replay recoverable without claiming delivery", async () => {
    mocked.turnstile.mockResolvedValueOnce(false);
    const verificationFailure = await POST(request());
    expect(verificationFailure.status).toBe(400);
    expect(await verificationFailure.json()).toMatchObject({ ok: false });
    expect(mocked.consume).not.toHaveBeenCalled();

    mocked.consume.mockResolvedValueOnce(false);
    const replay = await POST(request());
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ ok: false });
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("never claims production delivery when retrying a nonce consumed before provider failure", async () => {
    configureProduction();
    const incoming = request();
    const retry = incoming.clone();
    mocked.consume.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocked.send.mockRejectedValueOnce(new Error("provider failure with private details"));

    const failedDelivery = await POST(incoming);
    expect(failedDelivery.status).toBe(503);
    expect(await failedDelivery.json()).toMatchObject({ ok: false });
    const retriedDelivery = await POST(retry);
    expect(retriedDelivery.status).toBe(409);
    expect(await retriedDelivery.json()).toMatchObject({ ok: false });
    expect(mocked.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private details");
  });

  it("limits submissions before validation and provides a retry interval", async () => {
    mocked.limit.mockResolvedValue({ success: false, reset: Date.now() + 900000 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    const seconds = Number(response.headers.get("retry-after"));
    expect(seconds).toBeGreaterThanOrEqual(899);
    expect(seconds).toBeLessThanOrEqual(15 * 60);
    expect(mocked.send).not.toHaveBeenCalled();
  });

  it("refuses unsupported, oversized and malformed bodies", async () => {
    const unsupported = await POST(
      new Request("https://dataforge.test/api/contact", {
        method: "POST",
        headers: { origin: "https://dataforge.test", "content-type": "text/plain" },
        body: "{}",
      }),
    );
    expect(unsupported.status).toBe(415);
    const oversized = await POST(request({ projectDescription: "x".repeat(25000) }));
    expect(oversized.status).toBe(413);
    const malformed = await POST(
      new Request("https://dataforge.test/api/contact", {
        method: "POST",
        headers: { origin: "https://dataforge.test", "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(400);
  });

  it("fails production without configuration instead of reporting false delivery", async () => {
    const incoming = request();
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(incoming);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
    expect(mocked.send).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[contact] configuration unavailable:",
      expect.stringContaining("RESEND_API_KEY"),
    );
  });

  it("fails safely on Redis or delivery failure without reflecting private details", async () => {
    mocked.limit.mockRejectedValueOnce(new Error("private Redis credentials"));
    const redisFailure = await POST(request());
    expect(redisFailure.status).toBe(503);
    mocked.send.mockRejectedValueOnce(new Error("private inquiry details"));
    const deliveryFailure = await POST(request());
    expect(deliveryFailure.status).toBe(503);
    expect(await deliveryFailure.text()).not.toMatch(/private|Alex|example\.test/u);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(
      /credentials|inquiry details|Alex/u,
    );
  });
});
