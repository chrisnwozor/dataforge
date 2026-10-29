import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "@/lib/server/http";

const N = 32768,
  r = 8,
  p = 1,
  keyLength = 64;
export interface BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean>;
}
/** Replace at deployment with an offline corpus/provider. No network calls by default. */
export const breachedPasswordChecker: BreachedPasswordChecker = {
  isBreached: async () => false,
};
const processCrypto = globalThis as typeof globalThis & {
  dataforgeScrypt?: { active: number; waiting: (() => void)[] };
};
const queue = (processCrypto.dataforgeScrypt ??= { active: 0, waiting: [] });
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (queue.active >= 4) {
    if (queue.waiting.length >= 32)
      throw new HttpError(429, "Please try again shortly.");
    await new Promise<void>((resolve) => queue.waiting.push(resolve));
  } else queue.active++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        keyLength,
        { N, r, p, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    const next = queue.waiting.shift();
    if (next) next();
    else queue.active--;
  }
}
export async function validatePassword(
  password: string,
  checker = breachedPasswordChecker,
): Promise<void> {
  if (
    password.length < 12 ||
    password.length > 1024 ||
    Buffer.byteLength(password) > 4096
  )
    throw new HttpError(400, "Use a password between 12 and 1,024 characters.");
  if (await checker.isBreached(password))
    throw new HttpError(
      400,
      "Choose a password that has not appeared in a breach.",
    );
}
export async function hashPassword(password: string): Promise<string> {
  await validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
// Unknown accounts perform exactly the same expensive derivation as real accounts.
const dummySalt = Buffer.from("dataforge-dummy!", "utf8");
export async function verifyPassword(
  password: string,
  encoded?: string,
): Promise<boolean> {
  const parts = encoded?.split("$");
  const valid =
    parts?.length === 6 &&
    parts[0] === "scrypt" &&
    parts[1] === String(N) &&
    parts[2] === String(r) &&
    parts[3] === String(p) &&
    /^[\w-]{22}$/.test(parts[4]) &&
    /^[\w-]{86}$/.test(parts[5]);
  const result = await derive(
    password.length <= 1024 ? password : "invalid",
    valid ? Buffer.from(parts![4], "base64url") : dummySalt,
  );
  return (
    !!valid && timingSafeEqual(result, Buffer.from(parts![5], "base64url"))
  );
}
