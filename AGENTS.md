<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI standards

- Body text must be at least 14px.
- Secondary and caption text must never be smaller than 12px.
- All text and icons must meet WCAG AA contrast requirements in both dark and light themes: at least 4.5:1 for normal text and 3:1 for large text, icons, and UI components.
- Never truncate text without a tooltip or another way to see the full value.
- Integers such as years and IDs must never use thousands separators.
- Use consistent decimal precision and negative-number formatting across related values.
- Check every new screen at 125% and 200% browser zoom and at a viewport width of 380 px. Text must not be clipped or overlap.
- Charts must use axis labels of at least 12px, wrap or rotate long labels, and use a colorblind-safe palette.

Every feature that produces numbers must include a reconciliation test comparing its output with an independent calculation.
