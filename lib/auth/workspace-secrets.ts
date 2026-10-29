import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { decryptPassword, secretKey } from "@/lib/runner/secrets";
const validId = /^[a-zA-Z0-9_-]{1,40}$/;
function keyFor(keyId: string): Buffer {
  if (!validId.test(keyId))
    throw new Error("Invalid connection encryption key id.");
  const activeId = process.env.DATAFORGE_SECRET_KEY_ID || "primary";
  if (keyId === activeId) return secretKey();
  try {
    const previous = JSON.parse(
      process.env.DATAFORGE_SECRET_PREVIOUS_KEYS || "{}",
    );
    const value = previous[keyId];
    if (typeof value !== "string") throw new Error();
    const key = /^[a-fA-F0-9]{64}$/.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    if (key.length !== 32) throw new Error();
    return key;
  } catch {
    throw new Error(
      "The saved connection uses an unavailable key id. Restore its previous key or save the password again.",
    );
  }
}
function workspaceKey(workspaceId: string, keyId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      keyFor(keyId),
      Buffer.from(workspaceId),
      Buffer.from("dataforge:workspace:sql-password:v2"),
      32,
    ),
  );
}
export function encryptWorkspacePassword(
  password: string,
  workspaceId: string,
): string {
  const id = process.env.DATAFORGE_SECRET_KEY_ID || "primary";
  if (!validId.test(id))
    throw new Error(
      "DATAFORGE_SECRET_KEY_ID must use 1–40 letters, numbers, hyphens, or underscores.",
    );
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", workspaceKey(workspaceId, id), iv);
  cipher.setAAD(Buffer.from(`dataforge:${workspaceId}:${id}:v2`));
  const bytes = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    id,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    bytes.toString("base64"),
  ].join(":");
}
export function decryptWorkspacePassword(
  envelope: string,
  workspaceId: string,
): string {
  // Only the migrated, originally global connection may carry a v1 envelope.
  if (
    envelope.startsWith("v1:") &&
    workspaceId === "00000000-0000-4000-8000-000000000001"
  )
    return decryptPassword(envelope);
  try {
    const [version, id, ivText, tagText, bytesText, extra] =
      envelope.split(":");
    if (
      version !== "v2" ||
      !id ||
      !ivText ||
      !tagText ||
      bytesText === undefined ||
      extra !== undefined
    )
      throw new Error();
    const iv = Buffer.from(ivText, "base64"),
      tag = Buffer.from(tagText, "base64"),
      bytes = Buffer.from(bytesText, "base64");
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      iv.toString("base64") !== ivText ||
      tag.toString("base64") !== tagText ||
      bytes.toString("base64") !== bytesText
    )
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      workspaceKey(workspaceId, id),
      iv,
    );
    decipher.setAAD(Buffer.from(`dataforge:${workspaceId}:${id}:v2`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    throw new Error(
      "The saved password could not be unlocked. Check DATAFORGE_SECRET and the previous key ids, or save the password again.",
    );
  }
}
