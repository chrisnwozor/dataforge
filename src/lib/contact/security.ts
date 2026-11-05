import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ContactEnvironment } from "@/lib/env";

export const MINIMUM_SUBMIT_MS = 3000;
export const TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 24 * 1024;

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function requestIdentity(request: Request, env: ContactEnvironment) {
  // Vercel overwrites its forwarding header. Other hosts must explicitly trust their proxy.
  const forwarded = env.vercel
    ? (request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for"))
    : env.trustProxy
      ? request.headers.get("x-forwarded-for")
      : null;
  const candidate = forwarded?.split(",")[0]?.trim();
  const ip = candidate && isIP(candidate) ? candidate : "shared-connection";
  return signature(ip, env.tokenSecret);
}

export function isSameOrigin(
  request: Request,
  siteUrl?: string,
  requireSource = true,
  development = false,
) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const requestUrl = new URL(request.url);
  const allowed = new Set([siteUrl ? new URL(siteUrl).origin : requestUrl.origin]);
  if (development) {
    allowed.add(requestUrl.origin);
    const localHosts = ["0.0.0.0", "localhost", "127.0.0.1", "[::1]"];
    if (localHosts.includes(requestUrl.hostname)) {
      // Next dev may expose its bind address in Request.url while the browser
      // uses localhost. Only local aliases with the same protocol/port qualify.
      for (const hostname of localHosts) {
        const alias = new URL(requestUrl.origin);
        alias.hostname = hostname;
        allowed.add(alias.origin);
      }
    }
  }
  let hasSource = false;
  for (const key of ["origin", "referer"]) {
    const value = request.headers.get(key);
    if (!value) continue;
    hasSource = true;
    try {
      if (!allowed.has(new URL(value).origin)) return false;
    } catch {
      return false;
    }
  }
  return hasSource || !requireSource;
}

export function issueSubmissionToken(secret: string, identity: string, now = Date.now()) {
  const payload = Buffer.from(`${now}.${randomBytes(16).toString("hex")}.${identity}`).toString(
    "base64url",
  );
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySubmissionToken(
  token: string,
  secret: string,
  identity: string,
  now = Date.now(),
): { valid: true; nonce: string } | { valid: false } {
  const [payload, provided, extra] = token.split(".");
  if (!payload || !provided || extra || !/^[a-f0-9]{64}$/u.test(provided)) return { valid: false };
  const expected = signature(payload, secret);
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return { valid: false };
  const [timestamp, nonce, signedIdentity, trailing] = Buffer.from(payload, "base64url")
    .toString("utf8")
    .split(".");
  if (
    trailing ||
    !/^\d{13}$/u.test(timestamp ?? "") ||
    !/^[a-f0-9]{32}$/u.test(nonce ?? "") ||
    signedIdentity !== identity
  )
    return { valid: false };
  const age = now - Number(timestamp);
  if (age < MINIMUM_SUBMIT_MS || age > TOKEN_LIFETIME_MS) return { valid: false };
  return { valid: true, nonce };
}

export class ContactBodyError extends Error {
  constructor(readonly status: number) {
    super("Invalid contact body.");
  }
}

export async function readContactBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new ContactBodyError(415);
  if (
    request.headers.has("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  )
    throw new ContactBodyError(415);
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) throw new ContactBodyError(413);
  if (!request.body) throw new ContactBodyError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 5000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ContactBodyError(400)),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ContactBodyError(413);
      chunks.push(next.value);
    }
    const buffer = Buffer.concat(chunks);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof ContactBodyError) throw error;
    throw new ContactBodyError(400);
  } finally {
    reader.releaseLock();
  }
}

export function stripHeaderInjection(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
