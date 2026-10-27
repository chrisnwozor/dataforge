# DataForge

DataForge is a Next.js App Router workspace for turning CSV/Excel data into a warehouse model. Phase 1 implements **real uploads, SQLite projects, streaming profiling, and persistent type overrides**. The existing Model, Generate, and Runs tabs still use their original fixtures and simulations; they do not use uploaded data or connect to SQL Server yet.

## Run

Use **Node.js 22.13.0 or newer** (Node.js 24 LTS recommended) and **pnpm 11.25.0**. SQLite uses Node's built-in `node:sqlite` (`DatabaseSync`), available without an experimental flag from Node.js 22.13.0. No separate SQLite package, Python, make, or C++ compiler is needed, including on Windows.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Then open the app through your development environment. No credentials, remote database, or required environment variables are needed.

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

On a cloud machine with read-only user directories, install with writable caches:

```sh
XDG_DATA_HOME=/workspace/.local/share XDG_CACHE_HOME=/workspace/.cache \
  pnpm install --frozen-lockfile --store-dir /workspace/.pnpm-store
```

Use the existing isolated checkout; no worktree is necessary. `pnpm-workspace.yaml` permits the existing tooling build steps without an interactive approval prompt.

## Try an import

1. Open `/projects`. A new installation starts empty; projects are never seeded.
2. Choose **New project** and upload `samples/superstore_sales.csv` (2,000 realistic sales rows, 11 columns).
3. Enter a name and continue. The progress bar measures bytes uploaded; the final transfer state shows profiling until the server responds.
4. The app redirects to `/projects/<projectId>/profile`. Review counts, inferred types, null percentages, distinct/duplicate counts, min/max, and candidate keys.
5. Change a type and choose **Save overrides**. Refresh or restart the server: the override and project remain saved.

Bad file types, empty/malformed files, server errors, and files over 50 MB show an error in the upload form. Ragged CSV rows remain in the dataset and are counted/reported above the profile table; missing fields count as empty and extra fields are ignored. Returning to Projects shows persisted imports and their actual row/column counts.

The target database dropdown is still a preview setting: uploads do not connect to SQL Server, and the selected target does not change the stored profile.

## Local data

Default paths are relative to the repository root:

- `data/dataforge.db` — SQLite metadata, profiles, and overrides.
- `data/dataforge.db-wal` / `data/dataforge.db-shm` — SQLite WAL files while the database is open.
- `data/uploads/<projectId>/<sanitized-filename>.csv` or `.xlsx` — original source file.
- `data/uploads/<projectId>/profile-report.json` — delimiter and ragged-row report.

The entire `data/` directory is gitignored. Preserve this directory on persistent local storage when restarting or deploying the app. Do not place uploads in `public/`. `DATAFORGE_DATA_DIR` can optionally select a different data directory; automated checks use temporary directories so they never seed or remove your own projects. No data migration or sample-data import runs during build.

SQLite uses Node's built-in `DatabaseSync` with the `projects` and `column_profiles` tables in `lib/server/db.ts`, foreign keys, WAL, and parameterized transactional writes. Existing `data/dataforge.db` files work unchanged; no migration or re-import is needed. Samples are JSON-encoded text in `column_profiles.sample_values`; inferred types and override types are stored separately. Source files are retained when imports succeed; failed imports clean up their new upload directory and do not create a project.

## Profiling behavior

`lib/profiler/` is independent of the UI and database.

- CSV uses `csv-parse` in one streamed pass. Commas, semicolons, and tabs are detected outside quoted fields; quoted delimiters/newlines, UTF-8 BOM, and ragged rows are supported. Invalid UTF-8 or malformed quoting produces an actionable import error.
- A header row and at least one data row are required. Blank lines are skipped; whitespace-only fields count as null. Values are trimmed before profiling. Blank header cells receive a generated column name; column ordinals distinguish repeated headers.
- Exact distinct counts and non-null duplicate counts are computed over the complete dataset. Five distinct non-null sample values are retained. Null percentage uses all data rows. A key candidate requires no nulls and a distinct count equal to row count.
- Type inference inspects the **first 1,000 non-null values**, requiring a **95% match**. Types are integer, decimal, date, boolean, and text. Explicit true/false/yes/no values are boolean; numeric 0/1 stays integer. Integer and decimal min/max use exact numeric ordering; date min/max use chronological ordering. Non-matching minority values remain counted but are excluded from typed bounds.
- Dates use validated ISO dates/timestamps or US `MM/DD/YYYY`; invalid calendar dates are not guessed. Timestamps without a timezone are treated as UTC.
- XLSX uses the `xlsx` package and profiles the **first worksheet**. It is workbook-based rather than streamed. Limits: 50 MB uploaded file, 256 MB expanded ZIP content, 10,000 columns, 1,000,000 data rows, and 2,000,000 worksheet cells. ZIP64/encrypted or invalid workbooks are unsupported; export larger workbooks as CSV. CSV permits up to 10,000 columns.
- Exact distinct counting keeps a set of observed values per column, so profiling memory grows with unique data even though CSV parsing is streamed.

The UI retains its existing SQL-oriented type labels: `INT`, `DECIMAL`, `DATE`, `BOOLEAN`, and `VARCHAR`. The API and database use `integer`, `decimal`, `date`, `boolean`, and `text`. Selecting the originally inferred type clears a previous override.

## APIs

All handlers run on Node.js. Zod validates names, IDs, multipart fields, and overrides. JSON errors have the form `{ "error": "message" }` and a non-success HTTP status. Native request/body limits are enforced on the server independently of client validation or a declared Content-Length.

| Endpoint                           | Behavior                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                | `{ projects: StoredProject[] }` from SQLite.                                                                                  |
| `POST /api/projects`               | Multipart fields `name`, `file`, optional `targetDatabase`. Saves/profiles the source and returns `201 { project, profile }`. |
| `GET /api/projects/<id>/profile`   | `{ project, columns, report }`, including samples, inferred/override types, and ragged-row examples.                          |
| `PATCH /api/projects/<id>/profile` | JSON `{ overrides: [{ ordinal: 0, type: "text" }] }`; use `null` to reset. Returns `{ columns }`. The batch is atomic.        |

Storage contracts are in `lib/server/projects.ts`, profiler contracts in `lib/profiler/types.ts`, and UI contracts in `lib/types.ts`. `lib/data/index.ts` adapts live storage reads to the current UI. Projects and project routes render dynamically, so new imports and overrides appear without rebuilding.

## Later phases

`lib/data/mock.ts` retains the original Model, Generate, and Runs fixtures. The Model page's profile import points explicitly to that fixture module so a real upload cannot change or break the existing demo model. No Model editor, SQL generation, run execution, or run history behavior is implemented or changed in this phase. Their tabs remain reachable from each real project. The landing illustration also remains an illustration. Connection settings remain a frontend-only preview.

Future integration points:

- `components/model-editor.tsx`: persist reducer state and suggestions against real column ordinals.
- `getInitialModel`, `getSuggestedModel`: replace fixture model adapters.
- `getGeneratedFiles`, `components/generate-controls.tsx`: generate SQL for a persisted model and run real loads.
- `getRuns`, `components/runs-table.tsx`: persist execution logs and rejected rows.
- `components/settings-form.tsx`: manage real connections securely.

## Validation and architecture

Vitest covers inference thresholds and the 1,000-value limit, null/duplicate/key metrics, dates, numeric ordering, BOM and delimiters, quoted fields/newlines, ragged rows, invalid files, sample profiling, real XLSX parsing, SQLite persistence across reopen, atomic overrides, filename confinement, and server upload limits. Tests use temporary storage, not `data/`.

Server Components load data through `lib/data/`; interactive leaves handle upload, filters, type saves, theming, and menus. The existing design, routes, dark default, light mode, keyboard menus, focus rings, reduced motion, skeletons, and error boundaries are retained. The UI primitives are the Button and Radix-backed DropdownMenu in `components/ui/`.

`app/fonts/` contains Latin subsets of Geist Sans and Geist Mono from the `geist` package, loaded through `next/font/local`. Their SIL Open Font License is included. `scripts/subset-fonts.py` is an optional font maintenance tool requiring FontTools/Brotli; normal application builds need no Python font-generation step. Non-Latin text uses the system fallback font.
