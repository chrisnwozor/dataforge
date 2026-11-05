# Design system

## Direction and rhythm

Quiet, technical and editorial. Credibility comes from clear explanation, an honest delivery process and the supplied demonstration project. No invented scale, client badges or performance claims.

The homepage pairs a large serif statement with an original SVG: disconnected streams enter an ordered structure. A warm-white statement and numbered services index change the pace. Problems and approach return to navy; BankFlow is featured on warm white; the final consultation invitation is dark. Interior pages combine asymmetric splits, indexes, timelines and diagrams rather than repeating equal cards.

## Semantic palette

Actual tokens live in `src/app/globals.css`; `.tone-light` overrides the same names.

| Role             | Dark      | Warm white |
| ---------------- | --------- | ---------- |
| Background       | `#080e18` | `#f6f3ee`  |
| Surface          | `#101925` | `#eeebe5`  |
| Elevated surface | `#182433` | `#e6e2da`  |
| Primary text     | `#f6f3ee` | `#172333`  |
| Secondary text   | `#c4cdd7` | `#354357`  |
| Muted text       | `#a6b4c5` | `#4b5b6e`  |
| Accent           | `#b4c8dc` | `#354e6b`  |
| Control boundary | `#728398` | `#6e7a89`  |
| Focus            | `#c4d6e8` | `#274967`  |

`tests/design-tokens.test.ts` reads the CSS, independently computes sRGB luminance and checks every semantic foreground against all three surfaces at 4.5:1, focus/control pairs at 3:1, and inverted buttons. Decorative hairlines do not convey interaction or status alone. Diagram text has accessible alternatives.

## Type and spacing

- Instrument Serif, weight 400 regular/italic: editorial display headings. Its narrow forms support a confident headline without resembling a software interface.
- Geist Sans, weights 400/500: body and controls.
- Geist Mono, weight 400: technical labels and numbering.

All fonts are self-hosted through `next/font/local`, `display:swap`. Instrument Serif comes from Google Fonts' open-source repository. Existing Geist subsets and their license are retained; both licenses sit beside the files. No external font request is needed at build or runtime.

The scale uses 12px minimum captions,14px small text,17px body,19px leads, responsive42–68px section headings and60–120px hero display. Body line-height 1.7, headings1.05 (hero 0.96); prose stays near 65–72 characters. Labels are short and uppercase. Full labels wrap or have a readable alternative.

Content width 1248px; desktop gutters 64px, tablet 40px, mobile 24px (20px on small phones). Header/content/footer share edges. The 8px base scale grows 8/16/24/32/48/64/96/128. Sections scale from 80px mobile to 144px desktop. Equivalent halves, asymmetric five/seven splits and six-stage strips use a common12-column foundation.

## Motion and interaction

Server-rendered copy starts visible. Lazy Motion mini reveals move at most14px over400–700ms; the hero path draws once and the approach rail progresses with the viewport. Reduced motion preserves complete diagrams and disables drawing, transforms and transitions. Hover arrow movement has focus equivalents. No parallax, carousels, bouncing or cursor gimmicks.

Keyboard support includes a skip link, native dialog focus traps, mobile Escape/return focus, architecture explanation buttons, form error-summary focus and gallery arrows. Touch targets are at least44px. The browser checks independently reconcile the contact character count against the textarea. Colour never carries the only meaning.

## Inventory and choices

Container, Section, Eyebrow, PageIntro, ButtonLink and ClosingCta are shared primitives. Original illustrations include ClarityIllustration, six ServiceMotifs, four IndustryMotifs, ApproachTimeline, BankFlowPreview and BankFlowArchitecture. ContactForm and ScreenshotGallery are interactive leaves. The monogram/wordmark, favicon, Apple icon and OG image are generated in code.

Motion is reserved for enhancement. React Hook Form and its Zod resolver share validation with the server. Upstash packages provide distributed anti-abuse controls. Resend/Turnstile use HTTP interfaces without extra client SDKs. Lucide supplies functional icons. Native dialog/form primitives met the requirements without adding shadcn dependencies. Vitest, Playwright/axe and Prettier are development tools.

Do: preserve whitespace, truthful claims, precise diagrams, shared alignment and visible focus. Do not: add stock images, neon, icon circles, SaaS dashboards, fake reviews or unproven savings. Keep optional owner-content hooks hidden until real material exists.
