# Deployment and operations

## Vercel

Import `chrisnwozor/dataforge` in the owner's Vercel account. Use the **Next.js** preset, repository root, `pnpm install --frozen-lockfile`, `pnpm build`, Node 22.13+ and pinned pnpm. Deploy `redesign/consulting-site` as a preview first. This task does not publish or change an existing production project/domain.

Set the actual HTTPS origin in `NEXT_PUBLIC_SITE_URL` (no path/query/credentials). Use the preview’s own fixed HTTPS origin for preview contact testing, and the real production origin for production. Canonical-origin enforcement deliberately rejects submissions from a different preview host; do not weaken it to accept arbitrary domains. Redeploy after changing public variables. The local fallback is localhost with robots noindex, never an invented business domain. Configure DNS/TLS, contact providers and abuse protection, then verify the preview before promotion.

## Required production settings

| Name                       | Purpose                                                       |
| -------------------------- | ------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`     | Real canonical HTTPS origin                                   |
| `CONTACT_TOKEN_SECRET`     | At least32 random characters for HMAC tokens/identity hashing |
| `RESEND_API_KEY`           | Server-only email credential                                  |
| `CONTACT_FROM_EMAIL`       | Bare sender address on a Resend-verified domain               |
| `CONTACT_TO_EMAIL`         | Owner's inbox                                                 |
| `UPSTASH_REDIS_REST_URL`   | HTTPS distributed rate-limit/replay store                     |
| `UPSTASH_REDIS_REST_TOKEN` | Server-only Redis credential                                  |

Generate a new secret locally and enter the value directly into environment settings:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never commit secrets, add them to docs or prefix them with `NEXT_PUBLIC_`. `.env.example` contains names/comments only. Existing credentials/project links remain untouched.

Verify a real sender domain in Resend using its requested DNS records. Set the verified sender, destination and API key. After deployment, send a controlled test inquiry; verify owner receipt of plain-text/HTML content and submitter reply-to. No real credentials were supplied here, so live delivery requires the owner. No automated marketing/acknowledgement is sent.

Create Upstash Redis and set its REST pair. Production fails safely on missing settings/Redis errors; it never falls back to per-process limits. Policies:20 token GETs per minute and 5 POSTs per 15 minutes per hashed connection identity; signed tokens require 3 seconds and expire after 2hours; used nonces expire. The memory fallback is bounded to 10,000 entries and limited to development/test.

Recommended Turnstile: register the real hostname and configure `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` together. Widget action is `contact`; server verifies success/action/hostname. Test its real mobile/keyboard flow locally. Without the pair, no challenge script loads; timing, origin, honeypot, rate and replay checks remain.

Optional `NEXT_PUBLIC_CONTACT_EMAIL` shows a real public mailto. `CONTACT_TRUST_PROXY=true` is only safe behind a proxy that **overwrites** forwarding headers. Vercel's protected forwarding header is trusted automatically. Other untrusted connections conservatively share a rate-limit identity rather than trusting a forged header.

## Failure and privacy behavior

In development, missing email settings produce an explicit **no email sent** confirmation and a server notice without message contents. Partial/malformed settings identify invalid variable names only. Production missing required settings returns generic 503; invalid/expired challenges return recoverable errors. The form preserves input and offers retry. Only obvious honeypot bots are silently discarded. A normal production success follows actual delivery acceptance, not an unconfigured simulation.

The API revalidates shared Zod input, bounds UTF-8 JSON to 24KiB/5seconds, rejects unsupported types, checks Origin/Referer, protects headers/HTML and exposes no provider stack traces. The app does not persist messages or log their contents; configured Resend/Cloudflare/Upstash process data as explained in Privacy.

## CSP and rendering

`src/proxy.ts` generates a fresh nonce per HTML response. Script CSP uses nonce+strict-dynamic; production permits neither unsafe inline scripts nor eval. JSON-LD carries the nonce. Dynamic server rendering is intentional: static cached HTML cannot carry fresh request nonces. Inline **styles** remain allowed for React/Motion/image sizing. Turnstile frame/connect origins are enabled only when configured; no analytics script is installed.

Global headers include nosniff, frame denial, referrer/permissions policy and production HSTS. HTTPS responses upgrade insecure requests; local HTTP testing still works. Fonts are local and metadata images generated in code.

## Post-deployment verification

Check all nine pages, unique metadata/canonicals, JSON-LD, `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`, `/icon`, `/apple-icon` and `/opengraph-image`. Confirm the real origin replaced localhost/noindex. Test keyboard/mobile menu, validation, real delivered inquiry, failures and rate limits. Verify headers and zero console errors; run accessibility/Lighthouse against the deployed URL.

Owner-supplied items remain: genuine BankFlow screenshots, exact seven Gold table names, optional real About credentials/social profiles, public email and production provider/domain settings.

## Rollback

Use Vercel's previous known-good deployment to roll back. Git history is preserved. Restore the prior app on a new branch from `pre-redesign-checkpoint` or `archive/dataforge-app-pre-redesign`; see [MIGRATION](MIGRATION.md). Private ignored local data was kept outside Git, is unused by the website and should only be restored under the old app with its original configuration. Never expose it through the consulting site.
