import { viewConfigSchema, type ViewConfig } from "./config";

const MAX_URL_CONFIG = 64_000;

/** UTF-8 base64url works in both browser and Node without a runtime dependency. */
export function encodeViewConfig(config: ViewConfig): string {
  const bytes = new TextEncoder().encode(JSON.stringify(viewConfigSchema.parse(config)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoded.length > MAX_URL_CONFIG) throw new Error("This view is too large for a shareable URL. Save it and share its view link instead.");
  return encoded;
}

export function decodeViewConfig(encoded: string): ViewConfig | null {
  if (!encoded || encoded.length > MAX_URL_CONFIG || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return viewConfigSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}
