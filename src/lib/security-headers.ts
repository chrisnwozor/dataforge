export function contentSecurityPolicy(
  nonce: string,
  options: { development: boolean; turnstile: boolean; https: boolean },
): string {
  const challenge = options.turnstile ? " https://challenges.cloudflare.com" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.development ? " 'unsafe-eval'" : ""}${challenge}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self'${challenge}${options.development ? " ws: wss:" : ""}`,
    `frame-src ${options.turnstile ? "https://challenges.cloudflare.com" : "'none'"}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
export const staticSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];
