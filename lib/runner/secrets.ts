import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_MESSAGE =
  "Set DATAFORGE_SECRET in .env.local to a 32-byte base64 key (or a 64-character hex key), then restart DataForge.";

/** The key is never stored in SQLite or sent to a browser. */
export function secretKey(): Buffer {
  const secret = process.env.DATAFORGE_SECRET?.trim();
  if (!secret) throw new Error(`DATAFORGE_SECRET is missing. ${KEY_MESSAGE}`);
  if (/^[a-fA-F0-9]{64}$/.test(secret)) return Buffer.from(secret, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    const key = Buffer.from(secret, "base64");
    if (key.length === 32 && key.toString("base64") === secret) return key;
  }
  throw new Error(`DATAFORGE_SECRET is invalid. ${KEY_MESSAGE}`);
}

export function encryptPassword(password: string): string {
  const key = secretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("dataforge:sql-password:v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(password, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptPassword(envelope: string): string {
  const key = secretKey();
  try {
    const [version, ivText, tagText, ciphertextText, extra] =
      envelope.split(":");
    if (
      version !== "v1" ||
      !ivText ||
      !tagText ||
      ciphertextText === undefined ||
      extra !== undefined
    )
      throw new Error("Invalid envelope.");
    const iv = Buffer.from(ivText, "base64");
    const tag = Buffer.from(tagText, "base64");
    const ciphertext = Buffer.from(ciphertextText, "base64");
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      iv.toString("base64") !== ivText ||
      tag.toString("base64") !== tagText ||
      ciphertext.toString("base64") !== ciphertextText
    )
      throw new Error("Invalid envelope.");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from("dataforge:sql-password:v1", "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "The saved password could not be unlocked. Check DATAFORGE_SECRET or enter the password again and save.",
    );
  }
}

/** Literal replacement avoids treating password characters as regular expressions. */
export function redactSecrets(
  message: string,
  secrets: readonly string[],
): string {
  return secrets
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .reduce((safe, secret) => safe.split(secret).join("[redacted]"), message);
}
