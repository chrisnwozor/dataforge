# Verification and visual review

This report distinguishes executed checks from owner-dependent verification. No live Resend, Upstash or Turnstile credentials were supplied. Provider behavior is tested with doubles; local development success explicitly means no email was sent.

## Checkpoint and scope

The starting app and unfinished Q1 changes are preserved at commit `5caf00f5556f3f6e85dc07612db9a439c2d7460a`, branch `archive/dataforge-app-pre-redesign`, tag `pre-redesign-checkpoint`. Both were normally pushed before removal. Existing history/branches were retained; no force push was used. The replacement lives on `redesign/consulting-site`.

The previous app's routes, accounts, upload flows, SQL/database engines, dashboards and tests were removed in a separate commit. Ignored private local data remains untouched and unused. No real local environment file or Vercel project link was found at inspection. No secret values were printed or committed.

## Screenshot review rounds

The full matrix is nine routes × five viewports: **1440×900, 1024×768, 768×1024, 390×844, 360×740**. Each case captures full-page and above-the-fold images, checks page width, heading structure, JavaScript/console messages, and runs axe WCAG 2/2.1/2.2 A/AA rules. The final regression sweep includes the full A and AA tag sets for WCAG 2, 2.1 and 2.2; no selected rules are disabled. Earlier tag coverage and its correction are recorded below. Reduced motion is used for repeatable captures; motion/scroll behavior has separate interaction checks.

### Round 1: capture, critique, fixes

Executed all 45 route/viewport cases in development. Result: zero axe violations at any severity, zero horizontal overflow, one H1 per case, no heading-level skips and zero page exceptions. Five contact captures exposed failed token GETs (403), rather than hiding that failure.

Issues found and fixed:

- **Contact origin mismatch:** wildcard development bind address and localhost browser Referer differed. Added same-port/protocol loopback aliases in development only; production accepts only the configured canonical origin. Real localhost GET returned 200; foreign port/origin returned 403. Added regression tests.
- **Form focus race:** React Hook Form published errors after the invalid callback, so the summary did not yet exist when focus was requested. Focus now settles after errors mount without stealing focus while editing. Real browser invalid-summary, field-link and success-focus checks pass.
- **False success edge:** invalid/expired timing tokens, failed challenge and consumed nonce must not claim delivery. They now return recoverable 400/409 responses; only honeypot bots are silently discarded. Production delivery-failure/retry regressions pass.
- **Headline composition:** shortened Solutions and About headings to avoid isolated words and preserve complete phrases on desktop/mobile.
- **Approach rail:** replaced repeated SVG dash behavior with a continuous CSS prefix over the SVG track. Independently observed monotonic progress at three scroll positions; reduced motion shows the complete static rail. Exactly six semantic list items remain.
- **Diagram legibility:** enlarged BankFlow captions at intermediate widths; compact mobile preview now provides a readable HTML layer legend. Tiny decorative hero labels are omitted on mobile, with complete caption/description retained.
- **Detail polish:** corrected doubled services-index hairlines, used the static BankFlow preview on Home to avoid unnecessary interactive code, added gallery focus/hover parity, and improved the architecture disclosure affordance.

Round 1 follow-up completed the 11 interaction states and 107 source/link pairs: no failures. The actual HTTP signed-token GET and development POST succeeded; no email was sent. The form preserved fields and consent through an intentional 503, and its live count independently matched native input length (**139 / 139**). The original contact failure remains recorded in the round1 JSON, with the successful follow-up in a separate report.

### Round 2

Executed all 45 cases after the fixes: zero axe violations at any severity, zero overflow, zero page exceptions, zero normal-route console warnings/errors, one H1 per page and no heading-level skips. All 11 interaction states and 107 source/link pairs passed. Independent desktop/mobile review covered all editorial, work and contact pages; no new defects were found. The actual local POST again returned the explicitly labelled development no-email confirmation. Four local form-state review images are retained under `docs/screenshots/states/`.

### Round 3

Executed 45 production cases plus 27 supplemental checks (all nine routes at 380px and at 125%/200% equivalent viewport scaling). All selected-rule axe violations, overflow, page exceptions, console warnings/errors and heading skips were zero; one H1 per case. Seven interaction states and 107 source/link pairs passed. Production Contact made zero automatic API requests while unconfigured, displayed a clear unavailable panel with real next actions, and explicit API GET/POST returned safe 503s. Empty screenshot galleries and development indicators were absent. Final desktop/mobile images are under `docs/screenshots/`.

### Post-Lighthouse refinement and round 4

Lighthouse identified excessive homepage blocking time from the full Motion entry point and SVG accessible-name differences not caught by the earlier tag subset. Replacing the lazy import with `motion/mini` reduced homepage mobile blocking time from 740ms to 50ms and raised performance from 80 to 100. Transferred homepage script bytes fell from 174,369 to 153,520.

SVG sibling text/tspan nodes lacked real word boundaries. Explicit label whitespace now matches natural accessible names without hiding meaningful text or suppressing the rule. A regression compares normalized rendered text content exactly against each accessible name. Production desktop/mobile checks of both `label-content-name-mismatch` and `button-name` pass, and Lighthouse now passes that rule too.

The audit script was expanded to include the missing WCAG 2.1 A and 2.2 A tag groups. A fourth full production sweep refreshed all final images: 45 core cases, 27 supplements, seven interaction states and 107 source/link pairs, with zero failures, A/AA violations, overflow, page errors or console warnings/errors. Independent reviewers inspected final desktop, tablet, mobile and zoom-equivalent captures. All 28 retained images (18 routes, six production states, four clearly labelled development form states) reflect the relevant verified states.

## Commands and actual results

| Check                       | Command                                                                                    | Result                                                |
| --------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Install                     | `pnpm install --store-dir /workspace/.pnpm-store`                                          | Passed; lockfile regenerated normally                 |
| Formatting                  | `pnpm format`                                                                              | Applied; final check passed                           |
| Lint                        | `pnpm lint`                                                                                | Passed                                                |
| Unit/provider tests         | `pnpm test`                                                                                | 10 files, 121 tests passed                            |
| Typecheck/build             | `pnpm build`, `pnpm typecheck`                                                             | Passed; nine page routes and seven static assets      |
| Gallery keyboard fixture    | `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium node tests/bankflow-gallery.browser.mjs` | Passed; temporary route removed                       |
| Full dependency audit       | `pnpm audit --json`                                                                        | 0 critical/high; 1 moderate development-only advisory |
| Production dependency audit | `pnpm audit --prod --json`                                                                 | 0 vulnerabilities                                     |

The remaining development advisory is minimatch glob-part amplification in the TypeScript ESLint tooling chain. The published fix requires a major minimatch version. A forced transitive major override was not applied to the lint toolchain; repository-controlled lint patterns are not website inputs. Production dependencies are unaffected. Review/update the compatible tooling chain when upstream releases address it.

Unit tests cover shared input bounds/normalisation, signatures/timing, origin aliases and canonical checks, request size/encoding, honeypot behavior, rate/replay capacity, mocked distributed protection, Turnstile action/hostname, Resend acceptance/failure, production misconfiguration, HTML/header protection, actual CSS contrast, SEO/JSON-LD, content links and independent BankFlow record reconciliation.

## Reproduce browser checks

Start the site, then use Chromium installed by Playwright or an explicit executable:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium SITE_QA_ROUND=1 node scripts/site-qa.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium SITE_QA_ROUND=2 node scripts/site-qa.mjs
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium SITE_QA_ROUND=3 SITE_QA_FINAL=1 node scripts/site-qa.mjs
```

`SITE_QA_BASE_URL` defaults to `http://localhost:3000`. Full output is `/tmp/dataforge-qa/round-N/` and `/tmp/dataforge-qa-round-N.json`; final mode copies desktop/mobile route screenshots into docs. `SITE_QA_STATES_ONLY=1` runs focused interactions without replacing the full matrix. The script recognises production's safe unavailable contact panel; actual development form interaction is tested separately. Zoom checks use equivalent CSS viewport/device-pixel-ratio emulation and are labelled as such, not as browser-chrome zoom clicks.

## Remaining owner inputs and verification

- Real HTTPS domain and environment settings; Resend sender verification/delivery; live Upstash/Turnstile operation. Offline doubles do not prove external provider availability.
- Genuine BankFlow screenshots, exact seven Gold table names and optional real About credentials/social profiles. Empty production screenshot/team hooks stay hidden.
- Localhost intentionally emits noindex and disallows crawling until a real public canonical origin is supplied. Local SEO scores are not inflated by bypassing that safety policy; rerun against the owner-configured domain.

## Production metadata and compatibility

`node scripts/site-metadata.mjs` passed: nine pages have unique titles, descriptions, correct canonical links, valid JSON-LD and matching nonces on all inline scripts. All nine retain visible headings with JavaScript disabled. Organization/WebSite appear throughout; inner pages have BreadcrumbList; BankFlow has CreativeWork. Six metadata assets return200 with the correct types. Six retired/missing route checks return404, including Projects, Settings, Sign in and the old project/health APIs. Security headers and CSP are present; production emitted no script violations. The OG font is included in Next's output trace for serverless deployment.

Build, lint, all 121 tests and typecheck pass on Node 24.19.0 and the retained minimum Node 22.13.0. The Node 22 archive was downloaded from the official distribution and its SHA256 verified. The production server was also started on Node 22 for the final metadata/no-JavaScript/security smoke. Chromium is 154.0.8037.57. Lighthouse 13.6.0 ran under Node 24 with the production server, sequentially without other active browser audits.

## Lighthouse and transfer measurements

Local production HTTP, simulated mobile and desktop presets. Scores are measurements on this environment, not promises for every deployment. Local SEO is 66 because both the robots policy and page metadata deliberately block indexing without a real public canonical origin. That single indexing audit is the SEO shortfall; it was not bypassed or misrepresented as100. Owner configuration and a deployed recheck are required.

| Page          | Mode    | Performance | Accessibility | Best practices | SEO | LCP     | Blocking | Script transfer |
| ------------- | ------- | ----------- | ------------- | -------------- | --- | ------- | -------- | --------------- |
| home          | mobile  | 100         | 100           | 100            | 66  | 1080 ms | 52 ms    | 153520 bytes    |
| home          | desktop | 100         | 100           | 100            | 66  | 301 ms  | 0 ms     | 153520 bytes    |
| services      | mobile  | 98          | 100           | 100            | 66  | 1069 ms | 151 ms   | 148120 bytes    |
| services      | desktop | 100         | 100           | 100            | 66  | 301 ms  | 0 ms     | 148120 bytes    |
| work-bankflow | mobile  | 99          | 100           | 100            | 66  | 914 ms  | 134 ms   | 162522 bytes    |
| work-bankflow | desktop | 100         | 100           | 100            | 66  | 256 ms  | 0 ms     | 162522 bytes    |
| contact       | mobile  | 100         | 100           | 100            | 66  | 920 ms  | 55 ms    | 199076 bytes    |
| contact       | desktop | 100         | 100           | 100            | 66  | 257 ms  | 0 ms     | 199076 bytes    |

All measured CLS values are0. BankFlow now also passes Lighthouse's unweighted visible-label audit at both sizes. The Contact measurements represent the honest unconfigured production panel; rerun with real providers/Turnstile and actual image assets before launch. Lighthouse also reports non-scored back/forward-cache limitations caused by Next's no-store HTML/RSC responses. Those are retained with request-specific nonce rendering rather than weakening CSP or caching form-related responses to inflate diagnostics.

This Next16 build reports routes rather than per-route JavaScript sizes. The table therefore uses Lighthouse's actual compressed network script-transfer totals, including Next/React, not invented build-output numbers. The full production build reports nine page routes plus fallback/API routes and seven static metadata assets. The motion entry-point change removed roughly20.8KB of homepage script transfer and the blocking-time regression. No unusually large original image asset is shipped: the gallery is empty until real owner assets are registered.

Reproduce a measurement (use `--preset=desktop` for desktop and the other key URLs for Services, BankFlow and Contact):

```sh
CHROME_PATH=/usr/bin/chromium pnpm dlx lighthouse@13.6.0 http://localhost:3000/ --chrome-flags='--headless --no-sandbox --disable-dev-shm-usage' --output=json --output-path=/tmp/lighthouse-home-mobile.json --quiet
node scripts/site-metadata.mjs
```

Compact durable results are committed in `docs/qa-results.json`. Raw Lighthouse files are `/tmp/dataforge-lighthouse-<route>-<mode>.json`; initial pre-fix measurements were retained separately. These reports include the intentional localhost indexing restriction and the original homepage regression rather than hiding them.
