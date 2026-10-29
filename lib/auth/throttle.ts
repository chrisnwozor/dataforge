import { createHash } from "node:crypto";
import { getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
const key = (kind: string, value: string) =>
  `${kind}:${createHash("sha256").update(value).digest("hex")}`;
export function throttleKeys(email: string, ip: string): string[] {
  return [key("account", email), key("ip", ip)];
}
export function checkThrottle(keys: string[], now = Date.now()): void {
  for (const item of keys) {
    const row = getDatabase()
      .prepare("SELECT blocked_until FROM login_attempts WHERE key = ?")
      .get(item);
    if (row && Date.parse(String(row.blocked_until)) > now)
      throw new HttpError(
        429,
        "Unable to sign in right now. Please try again later.",
      );
  }
}
export function recordFailure(keys: string[], now = Date.now()): void {
  const db = getDatabase();
  for (const item of keys) {
    const row = db
      .prepare("SELECT failures, updated_at FROM login_attempts WHERE key = ?")
      .get(item);
    const failures =
      row && now - Date.parse(String(row.updated_at)) < 3600_000
        ? Number(row.failures) + 1
        : 1;
    const grace = item.startsWith("ip:") ? 10 : 4;
    const delay =
      failures > grace
        ? Math.min(900_000, 1000 * 2 ** Math.min(20, failures - grace - 1))
        : 0;
    db.prepare(
      "INSERT INTO login_attempts(key,failures,blocked_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at",
    ).run(
      item,
      failures,
      new Date(now + delay).toISOString(),
      new Date(now).toISOString(),
    );
  }
  db.prepare("DELETE FROM login_attempts WHERE updated_at < ?").run(
    new Date(now - 7 * 86400_000).toISOString(),
  );
}
export function clearAccountThrottle(email: string): void {
  getDatabase()
    .prepare("DELETE FROM login_attempts WHERE key = ?")
    .run(key("account", email));
}
