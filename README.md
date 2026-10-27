# DataForge

A frontend-only data warehouse workspace built with Next.js App Router, strict TypeScript, Tailwind CSS, shadcn-style UI primitives, Geist, and dnd-kit. Dark by default, with a browser-persisted theme preference. All project data and operations are simulated.

## Run locally

Use Node.js 22.13+ (Node 24 recommended) and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

For a production build:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

On the cloud machine, pnpm's user directories may be read-only. Install with writable cache locations if needed:

```sh
XDG_DATA_HOME=/workspace/.local/share XDG_CACHE_HOME=/workspace/.cache \
  pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store
```

No environment variables, credentials, database, or external services are required. Use the existing isolated checkout; no worktree is necessary.

## Explore

- `/` — landing page and three-step explainer
- `/projects` — search, status filter, sorting, grid/list views
- `/projects/new` — CSV/XLSX file picker, drop zone, simulated upload progress, project fields
- `/projects/superstore-sales` — overview, pipeline, activity, source details
- `/projects/superstore-sales/profile` — searchable, sortable profiles and local type overrides
- `/projects/superstore-sales/model` — drag-and-drop model editor and live SVG schema
- `/projects/superstore-sales/generate` — SQL tabs, copy/download, simulated incremental/full load
- `/projects/superstore-sales/runs` — run history, keyboard-accessible log sheet, rejected-row preview
- `/settings` — masked mock connection, schema validation, persistent theme

The other seeded projects also have all five project tabs. Project pages have loading skeletons and error boundaries. Unknown IDs show a 404.

### Keyboard interaction

Use Tab to navigate. In the model editor, focus a column's drag handle, press Space to pick up, arrow keys to move, then Space to drop or Escape to cancel. Each column also has a native select menu for moving directly to a table without dragging. SQL file tabs support arrow keys, Home, and End. Run-detail sheets close with Escape and trap focus until dismissed. Theme and icon actions have accessible labels. Reduced-motion preferences disable transitions and animation.

## Demo boundaries

Files are checked by **name and size only**; their contents are never read, parsed, transmitted, or stored. The selected file's metadata and project name are kept in session storage to personalize the new-project preview. That route uses the Superstore fixture, not the uploaded file. Project creation does not modify the seeded project list.

Model edits, column type overrides, connection settings, and schema settings live only in their respective screen's React state. Navigating away resets them. Suggested models and generated SQL are independent fixed fixtures: SQL does not regenerate from model edits. The incremental toggle changes the simulated load mode only. Simulated loads don't modify the static run history. Theme preference is the only durable browser setting. Never enter real credentials into the demo.

## Replace the mocks

All server reads go through typed async functions in **`lib/data/index.ts`**. Shared contracts live in **`lib/types.ts`**. Replace the following functions with API/database adapters when integrating a backend:

| Function in `lib/data/index.ts` | Real integration                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `getProjects`                   | List the authenticated workspace's projects.                                                             |
| `getProject`                    | Load a single project; return undefined for a missing or inaccessible project.                           |
| `getColumnProfiles`             | Return profiling results and persisted type overrides. The fixture is a representative 13-column subset. |
| `getInitialModel`               | Load a saved model for editing.                                                                          |
| `getSuggestedModel`             | Fetch a model suggestion for the selected source.                                                        |
| `getActivity`                   | Read the project's activity timeline.                                                                    |
| `getRuns`                       | Read run history, execution logs, and rejected rows.                                                     |
| `getGeneratedFiles`             | Fetch generated SQL files for a persisted model version.                                                 |

The adapters are intentionally asynchronous even though their fixtures are immediate. The seed projects share the same representative Superstore profiles, model, SQL, and run fixtures. Add authorization and runtime validation at the real integration boundary. Existing project routes are statically rendered via `generateStaticParams` in `app/projects/[id]/layout.tsx`; choose appropriate caching/revalidation and remove or change static params when wiring live user-specific data.

Replace client-side simulations at these integration points:

| File                               | Action to connect                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `components/new-project-form.tsx`  | Replace file-metadata handling, fake progress, and session-storage draft with a secure upload and project-create API. |
| `components/profile-table.tsx`     | Persist type overrides on Save; restore them from the profile adapter.                                                |
| `components/model-editor.tsx`      | Persist reducer state and request suggestions; pass the resulting model version into SQL generation.                  |
| `components/generate-controls.tsx` | Replace the timeout with a load mutation and streamed/polled run status.                                              |
| `components/settings-form.tsx`     | Use secure server-side connection management and persist schema preferences. Never expose raw credentials to clients. |
| `components/runs-table.tsx`        | Replace static log/rejected-row props with run detail reads if they become large.                                     |
| `components/project-identity.tsx`  | Remove session-storage personalization once projects come from the real adapter.                                      |

Presentational components are in `components/`; the installed shadcn primitives are `components/ui/button.tsx` and `components/ui/dropdown-menu.tsx` (Radix-backed menus). Navigation links prefetch on hover or keyboard focus to avoid loading every project tab at startup. The workspace switcher and status/sort menus support keyboard navigation and mark the active option. Filters, sheets, copy/download, theming, and dnd are client leaves; layouts and route data loading remain Server Components. There is no authentication, API route, file parser, database driver, chart library, or backend implementation.

## Validation

Run `pnpm lint`, `pnpm typecheck`, and `pnpm build`. Then start the production server and verify: search and status filters; a file-picker flow; profile sorting and a type override; drag and keyboard column moves; a suggested model and rename; SQL copy/download and incremental simulation; failed-run logs and rejected rows; light/dark themes; 390px and desktop layouts. Lighthouse targets should be measured against `pnpm start`, not the dev server.

## Fonts

`app/fonts/` contains Latin subsets of the variable Geist Sans and Geist Mono fonts from the installed `geist` package, loaded through `next/font/local`. The subsets reduce font transfer size without adding a build dependency; their SIL Open Font License is included alongside them. To regenerate after a Geist update, run `python3 scripts/subset-fonts.py` with FontTools and Brotli available in your Python tooling environment. Non-Latin text uses the system fallback font.
