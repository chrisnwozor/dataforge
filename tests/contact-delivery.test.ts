import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContactEmail, sendContactEmail } from "@/lib/contact/email";
import { verifyTurnstile } from "@/lib/contact/turnstile";
import { getContactEnvironment } from "@/lib/env";
import { contactSchema } from "@/lib/contact/schema";

const values = contactSchema.parse({
  name: "Alex & Morgan",
  businessName: "Example <business>",
  email: "alex@example.test",
  service: "cloud-data-engineering",
  projectDescription: "Please combine our <script>alert('example')</script> sales reports.",
  consent: true,
  submissionToken: "signed-token",
});
const environment = () =>
  getContactEnvironment({
    NODE_ENV: "test",
    RESEND_API_KEY: "test-api-key",
    CONTACT_TO_EMAIL: "owner@example.test",
    CONTACT_FROM_EMAIL: "inquiries@example.test",
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("email delivery", () => {
  it("escapes every user value in HTML and keeps a readable text alternative", () => {
    const email = buildContactEmail(values);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("Alex &amp; Morgan");
    expect(email.text).toContain(values.projectDescription);
    const tampered = buildContactEmail({
      ...values,
      businessName: "Name\r\nBcc: attacker@example.test",
      email: "alex@example.test\r\n",
    });
    expect(tampered.subject).not.toMatch(/[\r\n]/u);
    expect(tampered.reply_to).toBe("alex@example.test");
  });

  it("sends all fields through Resend with a safe reply-to and idempotency key", async () => {
    const transport = vi.fn().mockResolvedValue(Response.json({ id: "delivery-id" }));
    vi.stubGlobal("fetch", transport);
    expect(await sendContactEmail(values, environment(), "unique-nonce")).toBe("sent");
    const [url, options] = transport.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(options.headers).toMatchObject({ "Idempotency-Key": "contact-unique-nonce" });
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      to: ["owner@example.test"],
      from: "inquiries@example.test",
      reply_to: "alex@example.test",
    });
    expect(body.text).toContain("Privacy notice acknowledged:\nYes");
  });

  it("requires an accepted provider response with a delivery identifier", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    for (const response of [
      Response.json({ error: "rejected" }, { status: 500 }),
      Response.json({}),
      new Response("invalid-json", { status: 200 }),
    ]) {
      transport.mockResolvedValueOnce(response);
      await expect(sendContactEmail(values, environment(), "nonce")).rejects.toThrow();
    }
  });

  it("logs only a marked notice in local development and never bypasses production", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const env = getContactEnvironment({ NODE_ENV: "development" });
    expect(await sendContactEmail(values, env, "nonce")).toBe("development");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("DEVELOPMENT ONLY"));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Alex|example\.test|sales reports/u);
    await expect(
      sendContactEmail(values, { ...env, mode: "production" }, "nonce"),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("optional Turnstile", () => {
  it("degrades without configuration and validates hostname and action when enabled", async () => {
    const base = environment();
    const request = new Request("https://dataforge.test/api/contact");
    expect(await verifyTurnstile("", request, base)).toBe(true);
    const enabled = { ...base, turnstile: { secret: "test-secret", siteKey: "test-site-key" } };
    expect(await verifyTurnstile("", request, enabled)).toBe(false);
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    for (const [response, expected] of [
      [{ success: true, hostname: "dataforge.test", action: "contact" }, true],
      [{ success: true, hostname: "attacker.test", action: "contact" }, false],
      [{ success: true, hostname: "dataforge.test", action: "another-action" }, false],
      [{ success: false }, false],
    ] as const) {
      transport.mockResolvedValueOnce(Response.json(response));
      expect(await verifyTurnstile("widget-token", request, enabled)).toBe(expected);
    }
  });
});
