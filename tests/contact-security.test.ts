import { describe, expect, it } from "vitest";
import { contactSchema } from "@/lib/contact/schema";
import { getContactEnvironment, ContactConfigurationError } from "@/lib/env";
import { MemoryContactProtection, RATE_POLICIES } from "@/lib/contact/protection";
import {
  ContactBodyError,
  escapeHtml,
  isSameOrigin,
  issueSubmissionToken,
  MAX_BODY_BYTES,
  MINIMUM_SUBMIT_MS,
  readContactBody,
  requestIdentity,
  stripHeaderInjection,
  TOKEN_LIFETIME_MS,
  verifySubmissionToken,
} from "@/lib/contact/security";

const valid = {
  name: "Alex Morgan",
  businessName: "Example business",
  email: "alex@example.test",
  service: "cloud-data-engineering",
  projectDescription: "We need to combine sales and stock reports into a reliable view.",
  consent: true,
  submissionToken: "signed-token",
  website: "",
  turnstileToken: "",
};

describe("shared contact validation", () => {
  it("normalizes whitespace and email without changing project line breaks", () => {
    const result = contactSchema.parse({
      ...valid,
      name: "  Alex Morgan  ",
      email: " ALEX@example.test ",
      projectDescription: `  ${valid.projectDescription}\nA second line.  `,
    });
    expect(result.name).toBe("Alex Morgan");
    expect(result.email).toBe("alex@example.test");
    expect(result.projectDescription).toBe(`${valid.projectDescription}\nA second line.`);
  });

  it("accepts exact field boundaries and rejects characters beyond them", () => {
    expect(
      contactSchema.safeParse({
        ...valid,
        name: "a".repeat(100),
        businessName: "b".repeat(160),
        projectDescription: "x".repeat(30),
      }).success,
    ).toBe(true);
    expect(
      contactSchema.safeParse({ ...valid, projectDescription: "x".repeat(3000) }).success,
    ).toBe(true);
    for (const values of [
      { name: "x" },
      { name: "x".repeat(101) },
      { businessName: "x".repeat(161) },
      { projectDescription: "x".repeat(29) },
      { projectDescription: "x".repeat(3001) },
      { email: "invalid" },
      { email: "x".repeat(255) + "@example.test" },
      { consent: false },
      { service: "not-a-service" },
      { industry: "untrusted-extra-field" },
    ])
      expect(contactSchema.safeParse({ ...valid, ...values }).success).toBe(false);
  });

  it("rejects header injection and disallowed controls", () => {
    for (const values of [
      { name: "Alex\r\nBcc: attacker@example.test" },
      { email: "alex@example.test\r\nBcc: attacker@example.test" },
      { projectDescription: `${valid.projectDescription}\u0000` },
    ]) {
      expect(contactSchema.safeParse({ ...valid, ...values }).success).toBe(false);
    }
    expect(stripHeaderInjection("Acme\r\nBcc: hidden@example.test\u0000")).toBe(
      "Acme Bcc: hidden@example.test",
    );
    expect(escapeHtml(`<script a="'">&</script>`)).toBe(
      "&lt;script a=&quot;&#39;&quot;&gt;&amp;&lt;/script&gt;",
    );
  });
});

describe("signed timing tokens", () => {
  const secret = "test-secret-with-at-least-thirty-two-characters";
  const identity = "a".repeat(64);
  const issued = 1767225600000;

  it("reconciles the 3 second minimum and two hour expiry against independent arithmetic", () => {
    const token = issueSubmissionToken(secret, identity, issued);
    expect(MINIMUM_SUBMIT_MS).toBe(3 * 1000);
    expect(TOKEN_LIFETIME_MS).toBe(120 * 60 * 1000);
    expect(verifySubmissionToken(token, secret, identity, issued + 2999).valid).toBe(false);
    expect(verifySubmissionToken(token, secret, identity, issued + 3000).valid).toBe(true);
    expect(verifySubmissionToken(token, secret, identity, issued + 7200000).valid).toBe(true);
    expect(verifySubmissionToken(token, secret, identity, issued + 7200001).valid).toBe(false);
    expect(verifySubmissionToken(token, secret, identity, issued - 1).valid).toBe(false);
  });

  it("rejects tampering, another connection, another secret, and malformed tokens", () => {
    const token = issueSubmissionToken(secret, identity, issued);
    const validAt = issued + 10000;
    for (const value of [
      "",
      "not.signed",
      `${token}.extra`,
      `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`,
    ]) {
      expect(verifySubmissionToken(value, secret, identity, validAt).valid).toBe(false);
    }
    expect(verifySubmissionToken(token, secret, "b".repeat(64), validAt).valid).toBe(false);
    expect(verifySubmissionToken(token, "different-secret", identity, validAt).valid).toBe(false);
  });
});

describe("bounded development protection", () => {
  it("reconciles the fifth allowed submission, sixth refusal and 15 minute reset", () => {
    const memory = new MemoryContactProtection();
    const now = 1767225600000;
    expect(RATE_POLICIES.submission.windowMs).toBe(15 * 60 * 1000);
    const attempts = Array.from({ length: 6 }, () => memory.limit("submission", "connection", now));
    expect(attempts.map((attempt) => attempt.success)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(attempts[0].reset).toBe(now + 900000);
    expect(memory.limit("submission", "connection", now + 900000).success).toBe(true);
    expect(memory.limit("token", "connection", now).success).toBe(true);
  });

  it("bounds storage without evicting live restrictions or replay records", async () => {
    const memory = new MemoryContactProtection(1);
    expect(memory.limit("submission", "first", 1000).success).toBe(true);
    expect(memory.limit("submission", "second", 1000).success).toBe(false);
    expect(memory.limit("submission", "second", 901000).success).toBe(true);
    const replayResults = await Promise.all([
      Promise.resolve().then(() => memory.consume("nonce", 1000)),
      Promise.resolve().then(() => memory.consume("nonce", 1000)),
    ]);
    expect(replayResults).toEqual([true, false]);
    expect(memory.consume("other", 1000)).toBe(false);
    expect(memory.consume("other", 7201000)).toBe(true);
  });
});

describe("request boundaries", () => {
  it("requires same-origin POST source and rejects either mismatched source", () => {
    const request = (headers: HeadersInit) =>
      new Request("https://dataforge.test/api/contact", { headers });
    expect(isSameOrigin(request({ origin: "https://dataforge.test" }))).toBe(true);
    expect(isSameOrigin(request({ referer: "https://dataforge.test/contact" }))).toBe(true);
    expect(isSameOrigin(request({}))).toBe(false);
    expect(
      isSameOrigin(
        request({ origin: "https://attacker.test", referer: "https://dataforge.test/contact" }),
      ),
    ).toBe(false);
    expect(
      isSameOrigin(
        request({ origin: "https://dataforge.test", referer: "https://attacker.test/contact" }),
      ),
    ).toBe(false);
    expect(
      isSameOrigin(request({ origin: "https://dataforge.test", "sec-fetch-site": "cross-site" })),
    ).toBe(false);
  });

  it("permits development loopback aliases only on the same protocol and port", () => {
    const request = (source: string) =>
      new Request("http://0.0.0.0:3000/api/contact", {
        headers: { referer: source },
      });
    expect(isSameOrigin(request("http://localhost:3000/contact"), undefined, false, true)).toBe(
      true,
    );
    expect(isSameOrigin(request("http://127.0.0.1:3000/contact"), undefined, true, true)).toBe(
      true,
    );
    for (const source of [
      "http://localhost:3001/contact",
      "https://localhost:3000/contact",
      "http://attacker.test:3000/contact",
    ]) {
      expect(isSameOrigin(request(source), undefined, false, true)).toBe(false);
    }
    expect(isSameOrigin(request("http://localhost:3000/contact"), undefined, false, false)).toBe(
      false,
    );
  });

  it("requires the configured production origin even when the request URL uses another host", () => {
    const request = new Request("http://localhost:3000/api/contact", {
      headers: { origin: "http://localhost:3000", referer: "http://localhost:3000/contact" },
    });
    expect(isSameOrigin(request, "https://dataforge.test", true, false)).toBe(false);
    const canonical = new Request("http://0.0.0.0:3000/api/contact", {
      headers: { origin: "https://dataforge.test", referer: "https://dataforge.test/contact" },
    });
    expect(isSameOrigin(canonical, "https://dataforge.test", true, false)).toBe(true);
  });

  it("ignores untrusted forwarded headers and hashes trusted identifiers", () => {
    const env = getContactEnvironment({ NODE_ENV: "test", CONTACT_TOKEN_SECRET: "a".repeat(64) });
    const first = new Request("https://dataforge.test", {
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    const second = new Request("https://dataforge.test", {
      headers: { "x-forwarded-for": "192.0.2.2" },
    });
    expect(requestIdentity(first, env)).toBe(requestIdentity(second, env));
    expect(requestIdentity(first, { ...env, trustProxy: true })).not.toBe(
      requestIdentity(second, { ...env, trustProxy: true }),
    );
    expect(requestIdentity(first, { ...env, trustProxy: true })).not.toContain("192.0.2.1");
  });

  it("counts streamed UTF-8 bytes even with a false small Content-Length", async () => {
    const request = new Request("https://dataforge.test/api/contact", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body: JSON.stringify({ data: "é".repeat(MAX_BODY_BYTES / 2) }),
    });
    await expect(readContactBody(request)).rejects.toMatchObject({ status: 413 });
  });

  it("accepts JSON parameters and refuses malformed or unsupported bodies", async () => {
    const request = (body: string, headers: HeadersInit) =>
      new Request("https://dataforge.test/api/contact", { method: "POST", body, headers });
    expect(
      await readContactBody(
        request('{"ok":true}', { "content-type": "application/json; charset=utf-8" }),
      ),
    ).toEqual({ ok: true });
    await expect(
      readContactBody(request("{", { "content-type": "application/json" })),
    ).rejects.toBeInstanceOf(ContactBodyError);
    await expect(
      readContactBody(request("{}", { "content-type": "text/plain" })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readContactBody(
        request("{}", { "content-type": "application/json", "content-encoding": "gzip" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});

describe("lazy environment validation", () => {
  it("permits local development with no delivery but requires complete key groups", () => {
    expect(getContactEnvironment({ NODE_ENV: "development" }).delivery).toBeUndefined();
    expect(() =>
      getContactEnvironment({ NODE_ENV: "development", RESEND_API_KEY: "sensitive-example-value" }),
    ).toThrow(ContactConfigurationError);
    expect(() => getContactEnvironment({ NODE_ENV: "production" })).toThrow(
      ContactConfigurationError,
    );
  });

  it("reports names rather than values and permits HTTP only on local origins", () => {
    try {
      getContactEnvironment({ NODE_ENV: "test", CONTACT_FROM_EMAIL: "sensitive-invalid-value" });
    } catch (error) {
      expect(String(error)).toContain("CONTACT_FROM_EMAIL");
      expect(String(error)).not.toContain("sensitive-invalid-value");
    }
    expect(
      getContactEnvironment({ NODE_ENV: "test", NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000" })
        .siteUrl,
    ).toBe("http://127.0.0.1:3000");
    expect(() =>
      getContactEnvironment({ NODE_ENV: "test", NEXT_PUBLIC_SITE_URL: "http://public.example" }),
    ).toThrow(ContactConfigurationError);
  });
});
