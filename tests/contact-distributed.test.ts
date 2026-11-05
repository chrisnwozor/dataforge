import { beforeEach, describe, expect, it, vi } from "vitest";
import { contactProtection } from "@/lib/contact/protection";
import { getContactEnvironment } from "@/lib/env";

const mocked = vi.hoisted(() => ({
  redisOptions: vi.fn(),
  limiterOptions: vi.fn(),
  limit: vi.fn(),
  set: vi.fn(),
  algorithm: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    constructor(options: unknown) {
      mocked.redisOptions(options);
    }
    set(...args: unknown[]) {
      return mocked.set(...args);
    }
  },
}));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: class {
    constructor(options: unknown) {
      mocked.limiterOptions(options);
    }
    static fixedWindow(...args: unknown[]) {
      mocked.algorithm(...args);
      return "fixed-window-algorithm";
    }
    limit(...args: unknown[]) {
      return mocked.limit(...args);
    }
  },
}));

function environment() {
  return getContactEnvironment({
    NODE_ENV: "production",
    NEXT_PUBLIC_SITE_URL: "https://dataforge.test",
    CONTACT_TOKEN_SECRET: "test-contact-secret-with-at-least-thirty-two-characters",
    RESEND_API_KEY: "mock-key",
    CONTACT_TO_EMAIL: "owner@example.test",
    CONTACT_FROM_EMAIL: "inquiries@example.test",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test",
    UPSTASH_REDIS_REST_TOKEN: "mock-token",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.limit.mockResolvedValue({
    success: true,
    reset: 1767226500000,
    pending: Promise.resolve(),
  });
  mocked.set.mockResolvedValue("OK");
});

describe("distributed contact protection", () => {
  it("uses Upstash in production with independent policies and disables timeout fail-open", async () => {
    const protection = contactProtection(environment());
    expect(await protection.limit("submission", "hashed-connection")).toEqual({
      success: true,
      reset: 1767226500000,
    });
    expect(mocked.algorithm).toHaveBeenCalledWith(5, "900000 ms");
    expect(mocked.limiterOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "dataforge:contact:submission",
        timeout: 0,
        ephemeralCache: false,
        analytics: false,
      }),
    );
    expect(mocked.redisOptions).toHaveBeenCalledWith(
      expect.objectContaining({ retry: false, signal: expect.any(Function) }),
    );
    expect(mocked.limit).toHaveBeenCalledWith("hashed-connection");
    await protection.limit("token", "hashed-connection");
    expect(mocked.algorithm).toHaveBeenLastCalledWith(20, "60000 ms");
  });

  it("consumes replay nonces atomically with a two hour expiry", async () => {
    const protection = contactProtection(environment());
    mocked.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect(await protection.consume("random-nonce")).toBe(true);
    expect(await protection.consume("random-nonce")).toBe(false);
    expect(mocked.set).toHaveBeenCalledWith("dataforge:contact:used:random-nonce", "1", {
      nx: true,
      px: 120 * 60 * 1000,
    });
  });

  it("propagates Redis failures instead of falling back to process-local limits", async () => {
    const protection = contactProtection(environment());
    mocked.limit.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(protection.limit("submission", "hashed-connection")).rejects.toThrow(
      "transport unavailable",
    );
    mocked.set.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(protection.consume("nonce")).rejects.toThrow("transport unavailable");
    expect(() => contactProtection({ ...environment(), redis: undefined })).toThrow(
      "Contact protection unavailable.",
    );
  });
});
