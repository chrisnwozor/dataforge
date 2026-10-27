# DataForge

DataForge is a Next.js App Router workspace for turning CSV/Excel data into a warehouse model. Uploads, profiling, type overrides, model suggestions, and model edits use real local data and SQLite persistence. Generate produces real SQL Server 2019+ T-SQL from the saved model. DataForge does not connect to or execute against SQL Server. Runs retains its original fixtures and simulations.

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
6. Open **Model**. The first visit creates and saves a rules-based suggestion from the uploaded data. Rename tables or columns, move columns, choose business keys and aggregations, and edit the grain. Wait for **Saved**, then refresh to verify persistence.
7. Use **Suggested model** to regenerate from the current profile and type overrides. Confirm before replacing your draft. The validation panel keeps incomplete drafts visible while you edit.
8. Open **Generate** to review all six SQL files. Choose a target database and load mode; duplicate removal shares the saved model's flag. Model changes refresh the preview automatically. Resolve model errors before downloading.
9. Download individual scripts or **Download all (.zip)**, and download **Cleaned CSV** for the staging import. **Run load** stays disabled until execution is implemented in a later phase.

The Superstore sample has consistent customer-to-segment and product-to-category relationships. Its suggested model is `fact_sales` with Sales, Quantity, Discount (`AVG`), and Profit; a generated `dim_date`; customer, product, and region dimensions; and Order ID retained on the fact as a degenerate dimension. `samples/ircc-style.csv` is a small synthetic immigration-style dataset without a date column, for checking suggestions without a calendar dimension.

Bad file types, empty/malformed files, server errors, and files over 50 MB show an error in the upload form. Ragged CSV rows remain in the dataset and are counted/reported above the profile table; missing fields count as empty and extra fields are ignored. Returning to Projects shows persisted imports and their actual row/column counts.

The target database dropdown is still a preview setting: uploads do not connect to SQL Server, and the selected target does not change the stored profile.

## Local data

Default paths are relative to the repository root:

- `data/dataforge.db` — SQLite projects, profiles, overrides, and saved models.
- `data/dataforge.db-wal` / `data/dataforge.db-shm` — SQLite WAL files while the database is open.
- `data/uploads/<projectId>/<sanitized-filename>.csv` or `.xlsx` — original source file.
- `data/uploads/<projectId>/profile-report.json` — delimiter/ragged-row report and bounded paired rows used to evaluate model relationships.

The entire `data/` directory is gitignored. Preserve this directory on persistent local storage when restarting or deploying the app. Do not place uploads in `public/`. `DATAFORGE_DATA_DIR` can optionally select a different data directory; automated checks use temporary directories so they never seed or remove your own projects. No sample-data import or data migration runs during build.

SQLite uses Node's built-in `DatabaseSync` with the `projects`, `column_profiles`, and `models` tables in `lib/server/db.ts`, foreign keys, WAL, and parameterized transactional writes. Existing databases are upgraded with additive schema changes when opened. Older uploads are reprofiled lazily from their retained source file to capture table statistics and relationship evidence; existing type overrides and saved edits are preserved. Samples are JSON-encoded text in `column_profiles.sample_values`; inferred types and override types are stored separately. Source files are retained when imports succeed; failed imports clean up their new upload directory and do not create a project.

`projects.duplicate_row_count` counts extra occurrences of fully identical normalized rows, and `projects.total_null_cells` counts blank/missing cells over the complete source. Overview shows these alongside row and column counts. `models` stores one Zod-validated JSON document per project, its `suggested`/`edited` source, and `updated_at`. Model drafts remain saved even when the validation panel reports incomplete modeling decisions. Column profiles also retain complete-source maximum raw UTF-16 lengths and observed decimal scales for SQL sizing; older uploads are enriched lazily without replacing their model edits.

## Profiling behavior

`lib/profiler/` is independent of the UI and database.

- CSV uses `csv-parse` in one streamed pass. Commas, semicolons, and tabs are detected outside quoted fields; quoted delimiters/newlines, UTF-8 BOM, and ragged rows are supported. Invalid UTF-8 or malformed quoting produces an actionable import error.
- A header row and at least one data row are required. Blank lines are skipped; whitespace-only fields count as null. Values are trimmed before profiling. Blank header cells receive a generated column name; column ordinals distinguish repeated headers.
- Exact distinct counts and non-null duplicate counts are computed over the complete dataset. Five distinct non-null sample values are retained. Null percentage uses all data rows. **Key** requires no nulls and every value distinct. **Near-key** requires no nulls and at least 99.5% distinct values, excluding exact keys. Flags use exact counts, rather than rounded null percentages.
- Full-row duplicate detection uses SHA-256 fingerprints of normalized header-width rows: trimmed cells, blanks/missing fields as null, and extra ragged fields ignored. Total null cells and row statistics cover the entire dataset. Paired values for model suggestions retain the first 5,000 rows, capped at 4 MiB of JSON; column-level samples alone are never used to invent relationships.
- Type inference inspects the **first 1,000 non-null values**, requiring a **95% match**. Types are integer, decimal, date, boolean, and text. Explicit true/false/yes/no values are boolean; numeric 0/1 stays integer. Integer and decimal min/max use exact numeric ordering; date min/max use chronological ordering. Non-matching minority values remain counted but are excluded from typed bounds.
- Dates use validated ISO dates/timestamps or US `MM/DD/YYYY`; invalid calendar dates are not guessed. Timestamps without a timezone are treated as UTC.
- XLSX uses the `xlsx` package and profiles the **first worksheet**. It is workbook-based rather than streamed. Limits: 50 MB uploaded file, 256 MB expanded ZIP content, 10,000 columns, 1,000,000 data rows, and 2,000,000 worksheet cells. ZIP64/encrypted or invalid workbooks are unsupported; export larger workbooks as CSV. CSV permits up to 10,000 columns.
- Exact distinct counting keeps a set of observed values per column, so profiling memory grows with unique data even though CSV parsing is streamed.

The UI retains its existing SQL-oriented type labels: `INT`, `DECIMAL`, `DATE`, `BOOLEAN`, and `VARCHAR`. The API and database use `integer`, `decimal`, `date`, `boolean`, and `text`. Selecting the originally inferred type clears a previous override.

## Model suggestions and editing

`lib/modeling/suggest.ts` contains pure functions with no database or filesystem access. Suggestions use the effective column types, exact profile statistics, and paired sampled rows:

- Date columns share a generated calendar dimension with a `DateKey` link for each source date.
- Numeric columns become measures unless their names end in ID, key, code, or number, or they are key candidates. Discount, rate, pct, ratio, and price measures use `AVG` and are tagged non-additive; other measures default to `SUM`.
- Unique or near-unique text identifiers named for orders, invoices, transactions, or IDs stay on the fact as degenerate dimensions.
- Repeated text determinants group related attributes into dimensions when at least 99% of comparable rows agree with one dependent value per determinant value. Unique identifiers do not create vacuous dependencies. Other text columns receive their own dimensions. Reasons identify whether evidence covers sampled or complete rows.
- Dependency analysis checks at most 20,000 candidate pairs or 5,000,000 sampled row visits. If that budget is reached, a warning explains that unchecked columns remain separate dimensions for manual review.
- Grain follows a degenerate identifier or the finest dimension combination. Duplicate source rows produce a warning and a persisted **Remove exact duplicates** option. The generator implements this as a staging-row partition before loading facts. The original upload remains unchanged.

Table/column names, assignments, aggregation (`SUM`, `AVG`, `COUNT`, `MIN`, `MAX`), business keys, grain, and duplicate-removal intent are saved after a short debounce. The editor serializes writes, reports failures, and offers a retry. The live SVG uses the current model. Validation reports missing measures/business keys/grain, repeated assignments or table names, unassigned columns, and relationship issues. Regenerating explicitly replaces the saved model with a fresh suggestion; changing profile types alone does not discard edits.

## Run generated scripts in SQL Server

DataForge generates files for manual review and execution in **SQL Server 2019 or newer**, using SSMS or Azure Data Studio. Choose an existing target database in Generate; every file starts with an escaped `USE [database]` statement. The scripts create schemas and tables, so the executing account needs the corresponding DDL permissions. The application never receives a SQL Server connection string or executes these files.

Download the cleaned CSV and place it at a path readable by the **SQL Server service account**, such as `C:\DataForge\superstore_sales_cleaned.csv`. A path on your browser's computer is not automatically readable by a remote SQL Server. The cleaned download uses comma-separated UTF-8 with LF line endings and correctly escaped fields. CSV input is parsed and exported as a stream; XLSX input uses the same bounded first-worksheet reader as profiling, then emits CSV rows.

Open the scripts in filename order and execute them in the **same database connection/session**. `GO` separates batches in SSMS/Azure Data Studio; a project-specific session run ID links their log entries.

| File                | What it does                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_setup.sql`      | Creates `stg`, `dw`, and `etl`, plus run logging, rejected-row storage, and conversion helpers.                                                                         |
| `01_staging.sql`    | Truncates staging and imports raw text. **Replace the clearly marked `@FilePath` value here** with the SQL Server-readable cleaned CSV path.                            |
| `02_dim_date.sql`   | Creates the calendar from source date bounds with a one-year buffer and an Unknown member; safely does no calendar work when the model has no generated date dimension. |
| `03_dimensions.sql` | Creates dimensions, inserts Unknown members, deduplicates business keys, and merges new or changed descriptive values.                                                  |
| `04_fact.sql`       | Converts measures and dates, records rejected rows, resolves dimension keys, and loads facts in the selected mode.                                                      |
| `05_checks.sql`     | Reports row reconciliation, orphan/null keys, rejected-row samples, and measure aggregates using the model's chosen aggregation functions.                              |

Staging has one `NVARCHAR` column per source column and a generated `source_row_number` identity starting at 2. A raw-column-only import view lets `BULK INSERT` consume the original CSV field count while SQL Server assigns source record numbers. The file path is escaped into dynamic SQL because `BULK INSERT` requires a string literal. Staging never performs typed conversions.

SQL names are converted to snake_case, bounded to 128 characters, bracket-quoted, and given suffixes when names collide. String literals double embedded apostrophes. Text uses at least 50 UTF-16 code units with 25% headroom, switching to `NVARCHAR(MAX)` above 4,000. Integer bounds choose `INT` or `BIGINT`; decimals use `DECIMAL(18, s)` with observed scale clamped to 2–6. Missing descriptive text becomes `Unknown`; missing or unmatched dimension keys use surrogate key `-1`. Nonblank values that fail required conversions are logged and excluded from the fact.

Full refresh replaces the fact rows. Incremental mode keeps existing facts and loads rows strictly newer than the current maximum source-date watermark; rows on the watermark date, older corrections, and late arrivals are outside this mode. With no date column it falls back to full refresh and shows a warning. If dates exist but none supplies a stable persisted calendar link, date business key, or fact date identifier, incremental downloads are blocked until the model is fixed or full refresh is selected. Mutable dimension date attributes cannot safely supply a watermark after a dimension merge. Dimensions use `MERGE` in either mode. Exact duplicate removal happens before fact loading when enabled. Facts retain source-row grain; aggregation choices are reflected in the generated check queries rather than silently rolling up rows.

Each file uses object guards, a transaction, `TRY...CATCH`, and `etl.run_log` entries. Re-running the same scripts and options is supported. After changing model names, assignments, or types, regenerate and review the resulting DDL against the target schema; object guards do not migrate an already-created warehouse schema. `dw.reject_rows` retains the logical CSV record number, reason, and source values as JSON for inspection.

## APIs

All handlers run on Node.js. Zod validates names, IDs, multipart fields, and overrides. JSON errors have the form `{ "error": "message" }` and a non-success HTTP status. Native request/body limits are enforced on the server independently of client validation or a declared Content-Length.

| Endpoint                                | Behavior                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects`                     | `{ projects: StoredProject[] }` from SQLite.                                                                                       |
| `POST /api/projects`                    | Multipart fields `name`, `file`, optional `targetDatabase`. Saves/profiles the source and returns `201 { project, profile }`.      |
| `GET /api/projects/<id>/profile`        | `{ project, columns, report }`, including samples, inferred/override types, and ragged-row examples.                               |
| `PATCH /api/projects/<id>/profile`      | JSON `{ overrides: [{ ordinal: 0, type: "text" }] }`; use `null` to reset. Returns `{ columns }`. The batch is atomic.             |
| `GET /api/projects/<id>/model`          | Returns `{ model, source, updatedAt, validation }`; generates and stores a suggestion only when none exists.                       |
| `PUT /api/projects/<id>/model`          | JSON `{ model }`; validates structure and source references, then persists an edited draft and returns the saved record.           |
| `POST /api/projects/<id>/model/suggest` | Regenerates from the current profile, replaces the saved model, and returns a `suggested` record.                                  |
| `GET /api/projects/<id>/generate`       | Returns real `{ files, validation, modelUpdatedAt, options, savedDedupe, model }`; files contain `name`, `description`, and `sql`. |
| `GET /api/projects/<id>/generate/zip`   | Returns the six SQL files as a ZIP, or `409` when model errors prevent generation.                                                 |
| `GET /api/projects/<id>/source/cleaned` | Streams a cleaned comma-separated UTF-8 CSV from the retained source.                                                              |

Generation and ZIP accept `incremental=true|false`, `dedupe=true|false`, and `db=<existing database name>`. Boolean `1`/`0` are also accepted. Unknown or repeated query options are rejected. Omitting `dedupe` uses the saved model flag; query overrides alone do not modify the model. The Generate UI persists duplicate-removal edits through the existing model API. Database names must be nonempty, at most 128 characters, and contain no control characters. Download validation also checks SQL table/foreign-key limits and incompatible profile/model types.

Storage contracts are in `lib/server/projects.ts`, profiler contracts in `lib/profiler/types.ts`, model contracts in `lib/modeling/types.ts`, and UI profile/project contracts in `lib/types.ts`. `lib/data/index.ts` adapts live storage reads to the current UI. Projects and project routes render dynamically, so imports, overrides, and saved models appear without rebuilding.

## Later phases

`lib/data/mock.ts` retains the original Runs fixtures. Run execution and run history are unchanged in this phase. The Runs tab remains reachable from each real project and previews the original demo runs. The landing illustration also remains an illustration. Connection settings remain a frontend-only preview.

Future integration points:

- `components/generate-controls.tsx`: connect reviewed scripts to real execution in a later phase.
- `getRuns`, `components/runs-table.tsx`: persist execution logs and rejected rows.
- `components/settings-form.tsx`: manage real connections securely.

## Validation and architecture

Vitest covers inference thresholds, null/duplicate/key and near-key metrics, complete-row statistics, bounded paired sampling, dates and numeric ordering, CSV edge cases, XLSX parsing, every model suggestion rule, functional-dependency thresholds, model validation and editor moves, both sample datasets, SQLite persistence, additive migrations/backfill, atomic overrides, validated model APIs, and server input limits. Tests use temporary storage, not `data/`.

Generator tests snapshot the complete Superstore pipeline and check identifier/literal escaping, Unicode/collision handling, SQL types, duplicate removal, incremental/full behavior, Unknown members, and saved aggregations. `node-sql-parser` runs in the `transactsql` dialect against supported emitted statements from every file. Its grammar does not support the complete SQL Server language: procedural `IF`/`TRY...CATCH` wrappers, `MERGE`, dynamic `BULK INSERT` and function definitions, session context, `SET IDENTITY_INSERT`, foreign-key DDL, named inline primary-key constraints, `COUNT_BIG(*)`, and `FOR JSON PATH` are excluded explicitly. Parser checks do not replace SQL Server execution testing; this phase deliberately does not connect to SQL Server.

Server Components load data through `lib/data/`; interactive leaves handle upload, filters, type saves, theming, and menus. The existing design, routes, dark default, light mode, keyboard menus, focus rings, reduced motion, skeletons, and error boundaries are retained. The UI primitives are the Button and Radix-backed DropdownMenu in `components/ui/`.

`app/fonts/` contains Latin subsets of Geist Sans and Geist Mono from the `geist` package, loaded through `next/font/local`. Their SIL Open Font License is included. `scripts/subset-fonts.py` is an optional font maintenance tool requiring FontTools/Brotli; normal application builds need no Python font-generation step. Non-Latin text uses the system fallback font.
