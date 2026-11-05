# Consulting website migration

## Recoverable starting point

The starting application was a Next.js 16.4.3 App Router data-workspace application using React 19, TypeScript, Tailwind CSS 4 and pnpm 11.25.0. It included accounts, workspaces, uploads, preparation, profiling, SQL generation/execution, semantic querying, exploration, dashboards, reports and independent checks. The starting branch was `feat/dataforge-ui-readability`, based on `04a03c7` (the Checks merge), with unfinished Q1 presentation changes. Those changes are preserved rather than discarded.

Before removing application code, all tracked and non-ignored working changes were checkpointed on `archive/dataforge-app-pre-redesign`, tagged `pre-redesign-checkpoint`. Work continues separately on `redesign/consulting-site`. Git history and existing branches are retained. Normal branch/tag pushes are attempted; their results are recorded below once verified.

Restore the old application without rewriting history:

```sh
git fetch origin --tags
git switch -c restore/dataforge-app pre-redesign-checkpoint
pnpm install --frozen-lockfile
pnpm build
```

The checkpoint includes unfinished readability work, not a claim that that work passed its complete audit. The preceding committed application is also recoverable at `04a03c7`.

## Configuration inventory and decisions

- Keep Git history, repository ownership, `AGENTS.md`, the pnpm lockfile convention, Node `>=22.13.0`, TypeScript strictness, Next's App Router, Tailwind/PostCSS and Next ESLint configuration.
- Adapt the existing CI workflow to the consulting website's lint, typecheck, tests and build. Preserve the remote `https://github.com/chrisnwozor/dataforge.git`.
- Keep `.env*` ignored, with the explicitly permitted `.env.example` containing names and explanatory placeholders only. No real local environment file or `.vercel` project link was present at inspection; do not modify credentials or deployment links if supplied later.
- Remove obsolete application routes, instrumentation, SQL/database/ETL code, application components, sample data and their tests. Remove dependencies needed only by those features. Replace old application documentation with site-specific documentation; history retains it.
- Preserve the existing self-hosted Geist Sans/Mono assets and their license. Add a licensed self-hosted display font. No font request is needed at page load/build.
- Preserve ignored local `data/` contents, without opening or committing them. These may contain owner data and are not required by the new website; deleting them is unnecessary. The consulting site does not access them. This is a deliberate exception to removing disposable legacy database files, to keep private files recoverable without exposing them in Git.
- Retain deployment-related configuration that is still appropriate; replace old SQL/PDF output tracing. No Vercel project was linked and no Dockerfile or repository-level license file was found at inspection.

## Retired environment names

The old code referenced these names (values were not inspected or copied): `DATAFORGE_APP_URL`, `DATAFORGE_AUTH`, `DATAFORGE_BATCH_TIMEOUT_MS`, `DATAFORGE_BENCH_ROWS`, `DATAFORGE_DATA_DIR`, `DATAFORGE_EMAIL_FROM`, `DATAFORGE_SECRET`, `DATAFORGE_SECRET_KEY_ID`, `DATAFORGE_SECRET_PREVIOUS_KEYS`, `DATAFORGE_SMTP_HOST`, `DATAFORGE_SMTP_PASSWORD`, `DATAFORGE_SMTP_PORT`, `DATAFORGE_SMTP_SECURE`, `DATAFORGE_SMTP_USER`, `DATAFORGE_SQL_INTEGRATION`, `DATAFORGE_SQL_TEST_ENCRYPT`, `DATAFORGE_SQL_TEST_PORT`, `DATAFORGE_SQL_TEST_TRUST_CERTIFICATE`, `DATAFORGE_SQL_TEST_WRITE_DIR`, `DATAFORGE_STAGING_WRITE_DIR`, `DATAFORGE_TRUST_PROXY`, `DATAFORGE_VERIFY_INTEGRATION`, `DATAFORGE_VERIFY_SUPERSTORE_FILE`, and `NODE_ENV`.

These legacy service settings have no role in the consulting website. Do not delete them from an owner's deployment automatically. The website's new environment contract is documented separately in `.env.example` and `DEPLOYMENT.md`.

## Checkpoint verification

Verified normal push before removals:

```text
archive/dataforge-app-pre-redesign -> 5caf00f5556f3f6e85dc07612db9a439c2d7460a
pre-redesign-checkpoint (annotated tag) -> 06940d07c58074140e8840e9863131c12c43c2f9
working branch: redesign/consulting-site
```

The tag resolves to the checkpoint commit `5caf00f`. Both the branch and tag are present on origin.
