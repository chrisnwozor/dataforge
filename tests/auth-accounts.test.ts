import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from "@/lib/auth/passwords";
import {
  issueEmailToken,
  consumeEmailToken,
  tokenHash,
  tokenLifetimes,
} from "@/lib/auth/tokens";
import {
  createSession,
  readSession,
  SESSION_TTL,
  sessionCookie,
} from "@/lib/auth/sessions";
import {
  checkThrottle,
  recordFailure,
  throttleKeys,
} from "@/lib/auth/throttle";
import {
  changePassword,
  deleteAccount,
  resetPassword,
  sendRecovery,
  signIn,
  signOutEverywhere,
  signUp,
  verifyEmail,
} from "@/lib/auth/accounts";
import { requireUser, checkOrigin } from "@/lib/auth/guards";
import {
  emailTemplate,
  type EmailMessage,
  type EmailSender,
} from "@/lib/auth/email";
import { asUser, userFixture, workspaceFixture } from "./helpers/auth";
let directory: string;
const sent: EmailMessage[] = [],
  sender: EmailSender = {
    send: async (message) => {
      sent.push(message);
    },
  };
const req = () =>
  new Request("http://localhost/api/auth/sign-in", {
    headers: { "user-agent": "test browser" },
  });
const tokenFrom = (message: EmailMessage) =>
  new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "df-auth-accounts-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "on");
  vi.stubEnv("DATAFORGE_APP_URL", "http://localhost");
  sent.length = 0;
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
describe("scrypt password security", () => {
  it("uses independent salts, tuned parameters, and constant-length comparisons", async () => {
    const a = await hashPassword("an excellent long password"),
      b = await hashPassword("an excellent long password");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("an excellent long password", a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword("anything")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$999999999$8$1$x$y")).toBe(
      false,
    );
  });
  it("enforces length and supports an offline breached-password hook", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/12/);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow();
    const checker = { isBreached: vi.fn(async () => true) };
    await expect(
      validatePassword("breached password", checker),
    ).rejects.toThrow(/breach/);
    expect(checker.isBreached).toHaveBeenCalledOnce();
  });
});
describe("single-use email tokens", () => {
  for (const purpose of ["verify", "reset", "invite"] as const) {
    it(`${purpose} expires at the documented boundary and cannot be replayed`, () => {
      const user = userFixture(),
        now = Date.now(),
        a = issueEmailToken(user, purpose, now),
        b = issueEmailToken(user, purpose, now);
      const stored = getDatabase()
        .prepare("SELECT token_hash FROM email_tokens WHERE id=?")
        .get(a.id);
      expect(stored?.token_hash).toBe(tokenHash(a.token));
      expect(stored?.token_hash).not.toContain(a.token);
      expect(consumeEmailToken(a.token, purpose, now + 1).userId).toBe(user);
      expect(() => consumeEmailToken(a.token, purpose, now + 2)).toThrow(
        /used/,
      );
      expect(() =>
        consumeEmailToken(b.token, purpose, now + tokenLifetimes[purpose]),
      ).toThrow(/expired/);
    });
  }
  it("does not consume a token under a different purpose", () => {
    const t = issueEmailToken(userFixture(), "verify");
    expect(() => consumeEmailToken(t.token, "reset")).toThrow();
    expect(consumeEmailToken(t.token, "verify").id).toBe(t.id);
  });
  it("escapes branded templates and creates links from configured origin only", () => {
    const m = emailTemplate(
      "test@example.test",
      "invite",
      "safe-token",
      "<script>bad</script>",
    );
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.text).toContain("http://localhost/invite?token=safe-token");
    expect(m.text).toContain("7 days");
  });
});
describe("sessions and accounts", () => {
  it("rotates the login token, slides expiry, excludes tokens from list responses and revokes all devices", async () => {
    const user = userFixture(),
      workspace = workspaceFixture(user),
      now = Date.now(),
      first = createSession(user, req(), undefined, now),
      second = createSession(user, req(), first.token, now + 1000);
    expect(readSession(first.token, req(), now + 1001)).toBeNull();
    expect(
      readSession(second.token, req(), now + SESSION_TTL - 1)?.user.id,
    ).toBe(user);
    expect(
      readSession(second.token, req(), now + SESSION_TTL + 1000)?.user.id,
    ).toBe(user);
    expect(readSession(second.token, req(), now + 3 * SESSION_TTL)).toBeNull();
    const fresh = createSession(user);
    asUser(user, workspace, () => signOutEverywhere());
    expect(readSession(fresh.token)).toBeNull();
    expect(
      getDatabase()
        .prepare("SELECT token_hash FROM sessions WHERE token_hash=?")
        .get(fresh.token),
    ).toBeUndefined();
    expect(sessionCookie("x")).toContain("HttpOnly; SameSite=Lax");
  });
  it("uses Secure cookies in production and rejects disabled accounts", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookie("token")).toContain("; Secure");
    const id = userFixture();
    workspaceFixture(id);
    const session = createSession(id);
    getDatabase()
      .prepare("UPDATE users SET disabled_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
    expect(readSession(session.token)).toBeNull();
  });
  it("signs up lower-case email, claims legacy data only once, verifies then signs in", async () => {
    await signUp(
      {
        email: "FIRST@Example.test",
        name: "First",
        password: "my very long password",
      },
      req(),
      sender,
    );
    const first = getDatabase()
      .prepare("SELECT * FROM users WHERE email=?")
      .get("first@example.test")!;
    expect(first.email_verified_at).toBeNull();
    expect(String(first.password_hash)).not.toContain("my very long password");
    const session = await signIn(
      "FIRST@example.test",
      "my very long password",
      req(),
    );
    await expect(
      requireUser(
        new Request("http://localhost", {
          headers: { cookie: `dataforge_session=${session.token}` },
        }),
      ),
    ).rejects.toThrow(/Verify/);
    verifyEmail(tokenFrom(sent[0]));
    expect(
      (
        await requireUser(
          new Request("http://localhost", {
            headers: { cookie: `dataforge_session=${session.token}` },
          }),
        )
      ).user.id,
    ).toBe(first.id);
    await signUp(
      {
        email: "second@example.test",
        name: "Second",
        password: "second long password",
      },
      req(),
      sender,
    );
    expect(
      getDatabase()
        .prepare("SELECT created_by FROM workspaces WHERE slug='local'")
        .get()?.created_by,
    ).toBe(first.id);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM memberships WHERE role='owner'")
        .get()?.n,
    ).toBe(2);
  });
  it("returns generic duplicate signup and recovery responses without changing the account", async () => {
    await signUp(
      {
        email: "first@example.test",
        name: "First",
        password: "first long password",
      },
      req(),
      sender,
    );
    await signUp(
      {
        email: "first@example.test",
        name: "Fake",
        password: "different long password",
      },
      req(),
      sender,
    );
    expect(sent).toHaveLength(1);
    await sendRecovery("missing@example.test", "reset", req(), sender);
    expect(sent).toHaveLength(1);
    expect(
      getDatabase().prepare("SELECT COUNT(*) AS n FROM users").get()?.n,
    ).toBe(1);
  });
  it("reset and password change revoke every session and old reset token", async () => {
    const hash = await hashPassword("original long password"),
      id = userFixture(),
      workspace = workspaceFixture(id);
    getDatabase()
      .prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(hash, id);
    const first = createSession(id),
      reset = issueEmailToken(id, "reset"),
      other = issueEmailToken(id, "reset");
    await resetPassword(reset.token, "replacement long password");
    expect(readSession(first.token)).toBeNull();
    expect(() => consumeEmailToken(other.token, "reset")).toThrow();
    const second = createSession(id);
    await asUser(id, workspace, () =>
      changePassword("replacement long password", "another long password"),
    );
    expect(readSession(second.token)).toBeNull();
    expect(
      await verifyPassword(
        "another long password",
        String(
          getDatabase()
            .prepare("SELECT password_hash FROM users WHERE id=?")
            .get(id)?.password_hash,
        ),
      ),
    ).toBe(true);
  });
  it("deletion requires password and shared ownership transfer, then disables the account and revokes sessions", async () => {
    const id = userFixture(),
      workspace = workspaceFixture(id),
      hash = await hashPassword("correct long password");
    getDatabase()
      .prepare("UPDATE users SET password_hash=? WHERE id=?")
      .run(hash, id);
    const session = createSession(id);
    await expect(
      asUser(id, workspace, () => deleteAccount("wrong", true)),
    ).rejects.toThrow(/confirmed/);
    await expect(
      asUser(id, workspace, () =>
        deleteAccount("correct long password", false),
      ),
    ).rejects.toThrow(/Confirm/);
    await asUser(id, workspace, () =>
      deleteAccount("correct long password", true),
    );
    expect(readSession(session.token)).toBeNull();
    expect(
      getDatabase()
        .prepare("SELECT disabled_at,email FROM users WHERE id=?")
        .get(id),
    ).toMatchObject({
      disabled_at: expect.any(String),
      email: expect.stringContaining("deleted-"),
    });
    expect(
      getDatabase()
        .prepare(
          "SELECT action FROM audit_events WHERE action='account.deleted'",
        )
        .get()?.action,
    ).toBe("account.deleted");
  });
  it("rejects missing sessions by default and preserves explicit local mode", async () => {
    await expect(requireUser(req())).rejects.toThrow(/Sign in/);
    vi.stubEnv("DATAFORGE_AUTH", "off");
    expect((await requireUser(req())).local).toBe(true);
    vi.stubEnv("DATAFORGE_AUTH", "");
    await expect(requireUser(req())).rejects.toThrow(/Sign in/);
  });
  it("rejects cross-origin mutations and cookies without Origin, while allowing same-origin requests", () => {
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        }),
      ),
    ).toThrow(/DataForge/);
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { cookie: "dataforge_session=x" },
        }),
      ),
    ).toThrow(/Origin/);
    expect(() =>
      checkOrigin(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { origin: "http://localhost" },
        }),
      ),
    ).not.toThrow();
  });
});
describe("account and IP exponential throttling", () => {
  it("backs off accounts and IPs independently, exponentially and with a cap", () => {
    const now = Date.now(),
      keys = throttleKeys("a@example.test", "one");
    for (let i = 0; i < 5; i++) recordFailure(keys, now);
    expect(() =>
      checkThrottle(throttleKeys("a@example.test", "two"), now + 500),
    ).toThrow(/try again/);
    expect(() =>
      checkThrottle(throttleKeys("b@example.test", "one"), now + 500),
    ).not.toThrow();
    expect(() => checkThrottle(keys, now + 1001)).not.toThrow();
    for (let i = 0; i < 30; i++) recordFailure(keys, now);
    expect(() =>
      checkThrottle(throttleKeys("b@example.test", "one"), now + 899999),
    ).toThrow();
    expect(() => checkThrottle(keys, now + 900001)).not.toThrow();
    recordFailure(keys, now + 2 * 3600_000);
    expect(() => checkThrottle(keys, now + 2 * 3600_000 + 1)).not.toThrow();
  });
});
