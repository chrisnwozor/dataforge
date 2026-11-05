# DataForge

DataForge's consulting and inquiry website: data engineering, Microsoft Azure, integration, warehousing, business intelligence and data quality for small and medium-sized companies.

**We turn fragmented business data into reliable intelligence that supports better decisions.**

This is a marketing website, not the previous data-workspace application. BankFlow is clearly labelled a personal demonstration project using sample banking transactions. The old application, including unfinished readability work, is recoverable at `archive/dataforge-app-pre-redesign` / `pre-redesign-checkpoint`. See [MIGRATION](docs/MIGRATION.md).

## Local setup

Node **22.13+**, pnpm **11.25.0**. No SQL Server, native compiler or application database is needed.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:3000`. `.env.example` lists configuration names and comments; copy it to ignored `.env.local` when needed. Without delivery settings, development explicitly confirms that **no email was sent**. Production fails safely until contact delivery and abuse protection are configured.

```sh
pnpm lint
pnpm test
pnpm build
pnpm typecheck
pnpm start
pnpm format:check
```

Run build before standalone typecheck on a fresh checkout so Next generates route types. `pnpm format` applies Prettier. CI runs install, lint, tests, build and typecheck.

## Structure and editing

- `src/app/`: nine editorial routes, metadata assets and contact API.
- `src/content/`: typed, finished public copy, with empty optional owner-content hooks.
- `src/components/`: layout, illustrations, motion, contact and BankFlow components.
- `src/lib/`: validation, contact protection/delivery, SEO and security headers.
- `public/case-studies/bankflow/`: genuine screenshots when provided.
- `tests/`: offline provider doubles, security, contrast, content, SEO and metric reconciliation.
- `scripts/site-qa.mjs`: browser, accessibility, screenshots, links and interactions.

Next.js **16.4.5**, React **19.3.1**, strict TypeScript, Tailwind CSS, locally hosted Instrument Serif / Geist Sans / Geist Mono. Motion enhances visible server content. There are no stock photos, client logos or fabricated testimonials.

See [DESIGN](docs/DESIGN.md), [CONTENT](docs/CONTENT.md), [DEPLOYMENT](docs/DEPLOYMENT.md), and [QA-REPORT](docs/QA-REPORT.md) for design decisions, content editing, real screenshots, setup and actual verification evidence.

## Contact configuration

Production requires `NEXT_PUBLIC_SITE_URL`, `CONTACT_TOKEN_SECRET`, `RESEND_API_KEY`, `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Turnstile optionally uses `TURNSTILE_SECRET_KEY` and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` together. `NEXT_PUBLIC_CONTACT_EMAIL` optionally reveals a valid public mailto address. `CONTACT_TRUST_PROXY` is for a proxy that overwrites forwarding headers; Vercel's protected header is trusted automatically.

The site does not persist submitted messages or log their contents. Configured email and anti-abuse providers process requests as explained in the Privacy page. Offline tests do not claim live email delivery.

## Browser checks

Install Chromium with `pnpm exec playwright install chromium`, or use an existing `/usr/bin/chromium`. The scripts accept `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an explicit binary. Start the site and follow the exact browser commands in [QA-REPORT](docs/QA-REPORT.md). A separate gallery keyboard test is available:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/bankflow-gallery.browser.mjs
```

It temporarily creates and removes a development-only review route with an explicitly illustrative fixture. Test images are never presented as BankFlow project evidence.
