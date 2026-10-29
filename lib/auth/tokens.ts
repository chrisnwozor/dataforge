import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
export const tokenHash = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
export type TokenPurpose = "verify" | "reset" | "invite";
export const tokenLifetimes = {
  verify: 24 * 3600_000,
  reset: 3600_000,
  invite: 7 * 24 * 3600_000,
};
export function issueEmailToken(
  userId: string | null,
  purpose: TokenPurpose,
  now = Date.now(),
): { id: string; token: string } {
  const token = randomBytes(32).toString("base64url"),
    id = randomUUID();
  getDatabase()
    .prepare(
      "INSERT INTO email_tokens(id,user_id,purpose,token_hash,expires_at) VALUES(?,?,?,?,?)",
    )
    .run(
      id,
      userId,
      purpose,
      tokenHash(token),
      new Date(now + tokenLifetimes[purpose]).toISOString(),
    );
  return { id, token };
}
/** Atomic consumption: a token cannot be replayed by concurrent requests. */
export function consumeEmailToken(
  token: string,
  purpose: TokenPurpose,
  now = Date.now(),
): { id: string; userId: string | null } {
  if (!/^[\w-]{43}$/.test(token))
    throw new HttpError(400, "This link is invalid, expired, or already used.");
  const row = getDatabase()
    .prepare(
      "UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING id,user_id AS userId",
    )
    .get(
      new Date(now).toISOString(),
      tokenHash(token),
      purpose,
      new Date(now).toISOString(),
    );
  if (!row)
    throw new HttpError(400, "This link is invalid, expired, or already used.");
  return {
    id: String(row.id),
    userId: row.userId === null ? null : String(row.userId),
  };
}
