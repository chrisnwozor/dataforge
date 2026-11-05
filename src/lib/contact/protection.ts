import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import type { ContactEnvironment } from "@/lib/env";
import { TOKEN_LIFETIME_MS } from "@/lib/contact/security";

export const RATE_POLICIES = {
  token: { limit: 20, windowMs: 60 * 1000 },
  submission: { limit: 5, windowMs: 15 * 60 * 1000 },
} as const;
type Scope = keyof typeof RATE_POLICIES;
type RateResult = { success: boolean; reset: number };

/** Local-only, bounded storage. It is never a production fallback. */
export class MemoryContactProtection {
  private rates = new Map<string, { count: number; reset: number }>();
  private used = new Map<string, number>();
  constructor(private readonly capacity = 10000) {}

  limit(scope: Scope, identity: string, now = Date.now()): RateResult {
    for (const [key, entry] of this.rates) if (entry.reset <= now) this.rates.delete(key);
    const policy = RATE_POLICIES[scope];
    const key = `${scope}:${identity}`;
    const current = this.rates.get(key);
    if (current) {
      current.count += 1;
      return { success: current.count <= policy.limit, reset: current.reset };
    }
    const reset = now + policy.windowMs;
    if (this.rates.size >= this.capacity) return { success: false, reset };
    this.rates.set(key, { count: 1, reset });
    return { success: true, reset };
  }

  consume(nonce: string, now = Date.now()) {
    for (const [key, expiry] of this.used) if (expiry <= now) this.used.delete(key);
    if (this.used.has(nonce) || this.used.size >= this.capacity) return false;
    this.used.set(nonce, now + TOKEN_LIFETIME_MS);
    return true;
  }
}

const memory = new MemoryContactProtection();

export function contactProtection(env: ContactEnvironment) {
  if (!env.redis) {
    if (env.mode === "production") throw new Error("Contact protection unavailable.");
    return {
      limit: async (scope: Scope, identity: string) => memory.limit(scope, identity),
      consume: async (nonce: string) => memory.consume(nonce),
    };
  }
  const redis = new Redis({ ...env.redis, retry: false, signal: () => AbortSignal.timeout(5000) });
  return {
    limit: async (scope: Scope, identity: string): Promise<RateResult> => {
      const policy = RATE_POLICIES[scope];
      const limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.fixedWindow(policy.limit, `${policy.windowMs} ms`),
        prefix: `dataforge:contact:${scope}`,
        analytics: false,
        ephemeralCache: false,
        // The library's default timeout allows requests through. Disable that behavior;
        // the Redis transport aborts instead and the route returns a safe error.
        timeout: 0,
      });
      const result = await limiter.limit(identity);
      await result.pending;
      return { success: result.success, reset: result.reset };
    },
    consume: async (nonce: string) =>
      (await redis.set(`dataforge:contact:used:${nonce}`, "1", {
        nx: true,
        px: TOKEN_LIFETIME_MS,
      })) === "OK",
  };
}
