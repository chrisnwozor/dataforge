import { randomBytes } from "node:crypto";
import { z } from "zod";

const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);
const email = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .trim()
    .max(254)
    .email()
    .refine((value) => !/[\r\n]/u.test(value))
    .optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    NEXT_PUBLIC_SITE_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    CONTACT_TOKEN_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(32).optional(),
    ),
    RESEND_API_KEY: optionalText,
    CONTACT_TO_EMAIL: email,
    CONTACT_FROM_EMAIL: email,
    UPSTASH_REDIS_REST_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    UPSTASH_REDIS_REST_TOKEN: optionalText,
    TURNSTILE_SECRET_KEY: optionalText,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: optionalText,
    CONTACT_TRUST_PROXY: z.enum(["true", "false"]).optional(),
    VERCEL: z.string().optional(),
  })
  .superRefine((env, context) => {
    const requireTogether = (keys: (keyof typeof env)[]) => {
      const configured = keys.filter((key) => Boolean(env[key]));
      if (configured.length && configured.length !== keys.length) {
        for (const key of keys.filter((key) => !env[key])) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "Required with its related configuration.",
          });
        }
      }
    };
    requireTogether(["RESEND_API_KEY", "CONTACT_TO_EMAIL", "CONTACT_FROM_EMAIL"]);
    requireTogether(["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]);
    requireTogether(["TURNSTILE_SECRET_KEY", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"]);
    if (env.NEXT_PUBLIC_SITE_URL) {
      const url = new URL(env.NEXT_PUBLIC_SITE_URL);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      ) {
        context.addIssue({
          code: "custom",
          path: ["NEXT_PUBLIC_SITE_URL"],
          message: "Use an HTTPS origin, or HTTP localhost for local checks.",
        });
      }
    }
    if (env.UPSTASH_REDIS_REST_URL && new URL(env.UPSTASH_REDIS_REST_URL).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["UPSTASH_REDIS_REST_URL"], message: "Use HTTPS." });
    }
    if (env.NODE_ENV === "production") {
      for (const key of [
        "CONTACT_TOKEN_SECRET",
        "NEXT_PUBLIC_SITE_URL",
        "RESEND_API_KEY",
        "CONTACT_TO_EMAIL",
        "CONTACT_FROM_EMAIL",
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
      ] as const) {
        if (!env[key])
          context.addIssue({ code: "custom", path: [key], message: "Required in production." });
      }
    }
  });

export class ContactConfigurationError extends Error {
  constructor(readonly keys: string[]) {
    super(`Contact configuration is invalid: ${keys.join(", ")}.`);
    this.name = "ContactConfigurationError";
  }
}

const developmentSecret = randomBytes(32).toString("hex");

/** Validated only when the contact endpoint is used; unrelated pages remain available. */
export function getContactEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new ContactConfigurationError([
      ...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))),
    ]);
  }
  const env = result.data;
  return {
    mode: env.NODE_ENV,
    siteUrl: env.NEXT_PUBLIC_SITE_URL,
    tokenSecret: env.CONTACT_TOKEN_SECRET ?? developmentSecret,
    trustProxy: env.VERCEL === "1" || env.CONTACT_TRUST_PROXY === "true",
    vercel: env.VERCEL === "1",
    redis:
      env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
        ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
        : undefined,
    delivery:
      env.RESEND_API_KEY && env.CONTACT_TO_EMAIL && env.CONTACT_FROM_EMAIL
        ? { apiKey: env.RESEND_API_KEY, to: env.CONTACT_TO_EMAIL, from: env.CONTACT_FROM_EMAIL }
        : undefined,
    turnstile:
      env.TURNSTILE_SECRET_KEY && env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
        ? { secret: env.TURNSTILE_SECRET_KEY, siteKey: env.NEXT_PUBLIC_TURNSTILE_SITE_KEY }
        : undefined,
  };
}

export type ContactEnvironment = ReturnType<typeof getContactEnvironment>;
