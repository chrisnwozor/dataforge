# DataForge

DataForge is a Next.js App Router workspace for turning CSV/Excel data into a warehouse model. Uploads, profiles, models, connection settings, and run history persist in SQLite. Generate produces real SQL Server 2019+ T-SQL and can execute the generated pipeline with live logs, cancellation, and rejected-row previews. Connections use pure-JavaScript `mssql` with the `tedious` driver and SQL authentication. Windows/integrated authentication is outside this phase.

## Run

Use **Node.js 22.13.0 or newer** (Node.js 24 LTS recommended) and **pnpm 11.25.0**. SQLite uses Node's built-in `node:sqlite` (`DatabaseSync`), available without an experimental flag from Node.js 22.13.0. No separate SQLite package, Python, make, or C++ compiler is needed, including on Windows.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Then open the app through your development environment. Uploading, profiling, modeling, and downloading SQL work without SQL Server. Saving a connection and executing loads require `DATAFORGE_SECRET` and a SQL login, as described below.

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
9. Download individual scripts or **Download all (.zip)**, or configure a connection in **Settings**, then choose **Run load**. Confirm the displayed server, database, and mode. The run panel shows steps, live logs, cancellation, and summary counts; **Runs** retains history and the first 100 rejected rows.

The Superstore sample has consistent customer-to-segment and product-to-category relationships. Its suggested model is `fact_sales` with Sales, Quantity, Discount (`AVG`), and Profit; a generated `dim_date`; customer, product, and region dimensions; and Order ID retained on the fact as a degenerate dimension. `samples/ircc-style.csv` is a small synthetic immigration-style dataset without a date column, for checking suggestions without a calendar dimension.

Bad file types, empty/malformed files, server errors, and files over 50 MB show an error in the upload form. Ragged CSV rows remain in the dataset and are counted/reported above the profile table; missing fields count as empty and extra fields are ignored. Returning to Projects shows persisted imports and their actual row/column counts.

The target database choice during upload does not connect to SQL Server or change the stored profile. Actual execution uses the saved Settings connection; Generate's database must match that connection.

## Local data

Default paths are relative to the repository root:

- `data/dataforge.db` — SQLite projects, profiles, models, encrypted connection settings, runs, steps, logs, and rejected-row previews.
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

DataForge generates files for **SQL Server 2019 or newer**. Execute them through the confirmed **Run load** action or download them for manual review in SSMS/Azure Data Studio. Choose an existing target database; every file starts with an escaped `USE [database]` statement. The SQL login needs permissions to create the generated schemas/tables/functions, load data, and perform bulk imports.

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

Upload, Profile, Model, Measures, Generate, Settings, and Runs now use real application state. Legacy fixtures remain isolated in `lib/data/mock.ts`; active run/history adapters do not use them. The landing illustration remains an illustration.

Future integration points:

- Additional authentication providers and Windows integrated authentication.
- A separate durable worker/job queue for multi-instance or serverless deployments.

## Validation and architecture

Vitest covers inference thresholds, null/duplicate/key and near-key metrics, complete-row statistics, bounded paired sampling, dates and numeric ordering, CSV edge cases, XLSX parsing, every model suggestion rule, functional-dependency thresholds, model validation and editor moves, both sample datasets, SQLite persistence, additive migrations/backfill, atomic overrides, validated model APIs, and server input limits. Tests use temporary storage, not `data/`.

Generator tests snapshot the complete Superstore pipeline and check identifier/literal escaping, Unicode/collision handling, SQL types, duplicate removal, incremental/full behavior, Unknown members, and saved aggregations. `node-sql-parser` runs in the `transactsql` dialect against supported emitted statements from every file. Its grammar does not support the complete SQL Server language: procedural `IF`/`TRY...CATCH` wrappers, `MERGE`, dynamic `BULK INSERT` and function definitions, session context, `SET IDENTITY_INSERT`, foreign-key DDL, named inline primary-key constraints, clustered columnstore DDL, `COUNT_BIG(*)`, and `FOR JSON PATH` are excluded explicitly. An opt-in SQL Server integration test is provided to verify real execution when a dedicated server is configured.

Server Components load data through `lib/data/`; interactive leaves handle upload, filters, type saves, theming, and menus. The existing design, routes, dark default, light mode, keyboard menus, focus rings, reduced motion, skeletons, and error boundaries are retained. The UI primitives are the Button and Radix-backed DropdownMenu in `components/ui/`.

`app/fonts/` contains Latin subsets of Geist Sans and Geist Mono from the `geist` package, loaded through `next/font/local`. Their SIL Open Font License is included. `scripts/subset-fonts.py` is an optional font maintenance tool requiring FontTools/Brotli; normal application builds need no Python font-generation step. Non-Latin text uses the system fallback font.

## Connection and secret setup

Generate a 32-byte encryption key with Node, including on Windows:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy `.env.example` to `.env.local`, set `DATAFORGE_SECRET` to the generated value, and restart DataForge. A 64-character hexadecimal encoding of 32 random bytes is also accepted. Preserve this key with your deployment secrets across restarts; changing it requires entering and saving the SQL password again. Missing or invalid keys produce an actionable error instead of storing plaintext. `.env.local` is gitignored.

In **Settings**, enter server, port (default `1433`), an existing database, SQL user, password, and staging folder. **Encrypt** and **Trust server certificate** default to true; certificate trust is intended for local development. Save, then choose **Test connection**, which runs only `SELECT @@VERSION, DB_NAME()`. A saved password appears as a mask; an empty password input keeps it, and the browser never receives the stored password. Each password write uses AES-256-GCM with a fresh random IV and an authentication tag.

For local SQL Server, enable **SQL Server and Windows Authentication mode** in server properties and restart the service. Enable TCP/IP in SQL Server Configuration Manager, configure the listening port, and allow it through the firewall. Windows authentication is not implemented. An administrator can prepare a dedicated development database and SQL login in SSMS:

```sql
USE [master];
GO
CREATE DATABASE [DataForge];
GO
CREATE LOGIN [dataforge_app] WITH PASSWORD = N'REPLACE_WITH_A_STRONG_PASSWORD';
GRANT ADMINISTER BULK OPERATIONS TO [dataforge_app];
GO
USE [DataForge];
CREATE USER [dataforge_app] FOR LOGIN [dataforge_app];
ALTER ROLE [db_owner] ADD MEMBER [dataforge_app];
GO
```

The `db_owner` role is a convenient development setup for the generated DDL. Use a dedicated database and review permissions for a deployed environment.

## Staging folder access

**Staging folder** is a path as SQL Server sees it, such as `C:\Temp\DataForge` or `/var/opt/mssql/staging`. DataForge must also be able to write to the same underlying folder. On the same Windows machine, grant the app account **Modify** and the SQL Server service account **Read** on that folder. SQL authentication does not grant filesystem permissions.

For a remote SQL Server, mount a shared folder on the app host. Set `DATAFORGE_STAGING_WRITE_DIR` to that host's absolute mount path, while keeping the SQL Server-visible path in Settings. For example, Settings can contain `C:\Temp\DataForge` while a Linux app writes to `/mnt/sql-staging`. This maps the folder; it does not upload through SQL Server or automatically create an SMB share.

On Linux, use a shared group/default ACL so both processes can traverse the directory, DataForge can create/rename files, and SQL Server can read them. Files use mode `0640`, subject to the process umask; Windows uses inherited ACLs. The app streams a temporary file, then atomically renames it to `<project-id>.csv`. Control characters, relative paths, parent segments, and unsupported Windows device paths are rejected. The runner supplies the escaped SQL-visible path to the generator's `@FilePath` declaration. The CSV remains in the staging folder for inspection or reuse.

## Execution and real run history

Run DataForge as **one persistent Node process with persistent local storage**. Jobs run in that process; a serverless request lifetime is insufficient. A SQLite partial unique index permits one queued/running job per project; additional starts return `409`. Each run snapshots the model, options, and confirmed connection. If the connection version changes, the UI requires reviewing the target again.

The runner reserves one physical `tedious` connection, splits genuine standalone `GO` lines outside strings/comments, and executes files `00` through `05` sequentially. `GO 5` repeat directives are rejected. `DATAFORGE_BATCH_TIMEOUT_MS` defaults to `600000` (10 minutes) and accepts 1–3,600,000 ms. PRINT/low-severity RAISERROR messages and batch row counts become persisted log lines.

On failure it stops, records file/batch/SQL number/line/message, checks `@@TRANCOUNT`, and rolls back open transactions before releasing the connection and project lock. **Cancel** cancels the active request, waits for it to settle, and performs the same cleanup. Earlier completed scripts may already be committed. Process interruption closes the connection; stale runs are marked failed when history is read or another run is requested. Review the target before retrying an interrupted load.

The progress panel uses SSE with polling fallback. It shows step durations, level-colored Geist Mono logs, an auto-scroll pause, cancellation, and final counts. Success copies counts from `etl.run_log` and the first 100 rows from `dw.reject_rows` into SQLite. Runs has real history and an empty state; Overview marks Run complete after a successful load and lists actual runs. When **Remove exact duplicates** is enabled, duplicate warnings become an info note saying the rows will be removed.

SQLite adds `connection_settings`, `runs`, `run_steps`, `run_logs`, and `run_reject_rows`. Passwords are encrypted in `connection_settings`; run options contain generation choices only. The local run ID also identifies the matching SQL Server run/reject records. Credentials and keys are redacted from driver messages and rejected-row previews and are never returned in settings or run APIs.

Additional APIs:

| Endpoint                                      | Behavior                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/settings/connection`                | Public fields and saved/ready indicators; no password or ciphertext.                               |
| `PUT /api/settings/connection`                | Saves validated fields and an encrypted password; an omitted/empty password retains the saved one. |
| `POST /api/settings/connection/test`          | Tests form fields or saved settings with a fixed version/database query.                           |
| `GET /api/projects/<id>/runs`                 | Returns `{ runs }` from SQLite.                                                                    |
| `POST /api/projects/<id>/runs`                | Starts in the background and returns `202 { runId, run }`.                                         |
| `GET /api/projects/<id>/runs/<runId>`         | Returns `{ run, steps, logs, rejected }`.                                                          |
| `GET /api/projects/<id>/runs/<runId>/events`  | Full `snapshot`/`run` SSE events and heartbeats.                                                   |
| `POST /api/projects/<id>/runs/<runId>/cancel` | Returns detail after cancellation and cleanup.                                                     |

Start accepts only `{ incremental?, dedupe?, db?, connectionUpdatedAt? }`; its database must match Settings. The UI supplies the confirmed connection version; a mismatch returns `409`. No endpoint accepts arbitrary SQL, credentials in run options, or caller-specified scripts.

Troubleshooting:

- **Login failed:** verify SQL login/password, mixed authentication mode, database user mapping, and database access. Integrated Windows credentials are unsupported.
- **Cannot reach server / TCP/IP disabled:** enable TCP/IP, restart SQL Server after network changes, verify the listening port, and check firewall/container port mappings.
- **TLS error:** verify the server certificate and Encrypt options. Trust server certificate supports self-signed local development certificates.
- **BULK INSERT access denied / error 4861:** grant the SQL Server service account read/traverse access to the SQL-visible staging path and give the SQL login bulk-import permission. App write access alone is insufficient.
- **App cannot write staging CSV:** check app account permissions, mount availability, and `DATAFORGE_STAGING_WRITE_DIR`. A Windows path on Linux requires a mounted-folder mapping.
- **Password cannot be unlocked:** restore the original `DATAFORGE_SECRET` or enter and save the password again with the current key.

## Opt-in SQL Server integration test

Default tests use driver doubles and do not require SQL Server. They cover the GO lexer, path escaping/mapping, authenticated encryption, state transitions, concurrency locks, generated-only execution order, physical connection pinning, failures/timeouts, cancellation/rollback, secret redaction, and SSE cleanup.

The real integration test is **skipped by default**. For a dedicated disposable SQL Server database, export `DATAFORGE_SQL_INTEGRATION=1` and these variables in the shell running the tests:

```text
DATAFORGE_SQL_TEST_SERVER=localhost
DATAFORGE_SQL_TEST_PORT=1433
DATAFORGE_SQL_TEST_DATABASE=DataForgeIntegration
DATAFORGE_SQL_TEST_USER=dataforge_app
DATAFORGE_SQL_TEST_PASSWORD=<SQL login password>
DATAFORGE_SQL_TEST_STAGING_FOLDER=C:\Temp\DataForge
# Optional app-side mount, particularly across operating systems:
DATAFORGE_SQL_TEST_WRITE_DIR=/mnt/sql-staging
```

Run `pnpm test tests/sql-server.integration.test.ts`. It uses temporary SQLite storage and a temporary encryption key, uploads `samples/superstore_sales.csv`, executes a full deduplicated pipeline, and asserts `dw.fact_sales = 2,000` with zero rejects. It modifies generated objects in the supplied database and retains SQL objects/staging CSV afterward. Do not point it at a database containing data you need to keep. Optional `DATAFORGE_SQL_TEST_ENCRYPT=false` and `DATAFORGE_SQL_TEST_TRUST_CERTIFICATE=false` change TLS behavior; both default true for local development.

## Semantic layer and Measures

After configuring a connection and completing a successful load, open the **Measures** tab next to Model. DataForge derives tables, column roles, and many-to-one relationships using exactly the SQL names resolved by the warehouse generator. Defaults include the fact's saved aggregations, **Row Count**, distinct counts for degenerate identifiers, a calendar hierarchy, and dimension hierarchies supported by the profile's functional-dependency evidence. It never invents ratio measures. Calendar models also receive YTD, MTD, QTD, last-year, and YoY measures for each SUM measure.

Measures are grouped in folders. Add or edit a name, expression, format, folder, and description; live validation reports errors and shows generated SQL. Save before using **Test value**, which queries the measure without grouping. The query tester can group selected measures by one or two attributes and displays results, elapsed time, cache status, and SQL. The hierarchy list shows coarse-to-fine levels. **Regenerate defaults** refreshes automatic definitions while retaining user-defined measures. Editing an automatic measure makes it a user definition.

SQLite stores validated definitions in `semantic_measures` and `semantic_hierarchies`; schema upgrades are additive. Semantic edits change the semantic version and invalidate the project's cached results. After changing physical table or column names in Model, reload the warehouse and regenerate semantic defaults before querying it; custom definitions remain available for editing.

### Expression language

This is a small DataForge language, **not DAX**. It has no SQL statements, comments, evaluation functions, or arbitrary functions. Expressions are limited to 2,000 characters and 12 nesting levels; referenced-measure expansion has a compile-time budget and detects cycles. Unknown references include their character position and a suggested matching name when available.

| Syntax                                       | Meaning / example                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literals                                     | Numbers, `'strings'`, `TRUE`, `FALSE`, `NULL`. Escape an apostrophe as `''`.                                                                                               |
| `[Measure Name]`                             | A saved measure, for example `[Sales]`. Escape a closing bracket as `]]`.                                                                                                  |
| `Table[Column]`                              | A validated semantic column, for example `fact_sales[Sales]`. A table name containing spaces can be quoted as `'Fact Sales'[Sales]`.                                       |
| Aggregations                                 | `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`, `DISTINCTCOUNT` over a fact column; `COUNT_BIG(*)` for row counts.                                                                    |
| Arithmetic                                   | `+`, `-`, `*`, `/`, parentheses, comparisons, `AND`, `OR`, `NOT`. Prefer `DIVIDE` for a safe zero denominator.                                                             |
| `DIVIDE(a, b, alternate)`                    | Null-safe division; alternate defaults to `NULL`. Example: `DIVIDE([Profit], [Sales], 0)`.                                                                                 |
| `IF(condition, a, b)`                        | Conditional scalar expression. Example: `IF([Sales] > 0, [Profit], 0)`.                                                                                                    |
| `ABS`, `ROUND`                               | Numeric scalar functions, for example `ROUND(ABS([Profit]), 2)`.                                                                                                           |
| `CALCULATE(expr, filter, ...)`               | Changes aggregation filter context, for example `CALCULATE([Sales], dim_product[Category] = 'Furniture')` or `CALCULATE([Sales], dim_region[Region] IN ('East', 'West'))`. |
| `ALL(Table[Column])`                         | Used inside `CALCULATE` to remove that attribute's filtering/grouping context, for example `DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[Category])))`.              |
| `YTD`, `MTD`, `QTD`                          | Calendar-to-date aggregates, for example `YTD([Sales])`.                                                                                                                   |
| `SAMEPERIODLASTYEAR(expr)`                   | Evaluates the corresponding date interval one year earlier.                                                                                                                |
| `PREVIOUSPERIOD(expr, MONTH\|QUARTER\|YEAR)` | Evaluates the previous calendar period.                                                                                                                                    |

Time functions require the generated calendar relationship. They use set-based SQL with date context from the query, preserve non-date grouping, and do not create scalar UDFs or cursors. Auto YoY uses null-safe division, so an absent or zero prior period returns `NULL`. Format `percent` displays a fraction as a percentage; the SQL result remains a numeric fraction.

Identifiers come from resolved semantic metadata and are bracket-escaped. Literal/filter values become typed SQL parameters. Quotes, brackets, semicolons, or SQL-looking text in a name or filter cannot add a statement. The parser, type checker, dependency resolver, and compiler run on the server before any database request.

### Query API and cache

All semantic/query endpoints require a configured connection and a successful project run; otherwise they return `409` with setup guidance. They use the saved SQL-auth connection. No endpoint accepts SQL text. The generated query is one parameterized SELECT (possibly using CTEs), joins only required dimensions, has a 30-second timeout, caps results, and cancels with the request's AbortSignal.

| Endpoint                                             | Behavior                                                                                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/projects/<id>/semantic`                    | Returns the derived semantic model, saved measures, hierarchies, and version; initializes defaults on first use.                                   |
| `PUT /api/projects/<id>/semantic`                    | Saves `{ measures, hierarchies, version? }` with schema/expression validation and optional version conflict detection.                             |
| `POST /api/projects/<id>/semantic/measures/validate` | Accepts `{ expression }`; returns validation details, an AST summary, dependencies, and compiled SQL preview.                                      |
| `POST /api/projects/<id>/semantic/regenerate`        | Rebuilds automatic defaults without deleting custom measures.                                                                                      |
| `POST /api/projects/<id>/query`                      | Executes a validated semantic query and returns columns, rows, row count, truncation, elapsed milliseconds, cache status, and generated SQL.       |
| `GET /api/projects/<id>/query/values?attribute=...`  | Returns up to 1,000 distinct attribute values with counts for slicers; the attribute can be a column ID or a URL-encoded JSON attribute reference. |

Query attribute references use `{ "table": "<table id>", "column": "<column id>" }` from the returned semantic model. A basic request is:

```json
{
  "measures": ["<measure id>"],
  "rows": [{ "table": "<table id>", "column": "<column id>" }],
  "filters": [],
  "orderBy": [],
  "limit": 1000,
  "hideUnknown": true
}
```

The maximum limit is 50,000. Filters use `{ attribute, op, value }`, or `values` for `in`/`notIn`; supported operations are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `isNull`, and `isNotNull`. Ordering uses `{ ref, dir: "asc" | "desc" }`, where the reference is a selected measure/column ID or attribute reference. Optional `topN: { measure, n }` sorts by a selected measure. Optional `columns` requests a long result plus a client-pivot hint and limits distinct column-axis tuples to 50. Unknown members of referenced dimensions are hidden by default; use `hideUnknown: false` to include them. Result column keys are generated aliases such as `a0`/`m0`; use the returned column metadata to read each row.

The process-local LRU holds at most **200 entries / 64 MiB**, including slicer results. Keys contain project ID, latest successful run ID, semantic version, connection version, and normalized query options. Successful loads and semantic edits invalidate that project's entries. A restart clears the cache; eviction or an oversized result simply causes a later query to execute again. Returned SQL contains parameter placeholders rather than interpolated values.

### Query performance and timing

Every query response includes a `timings` object, including cache hits and query errors. The **Generated SQL → Timing** section shows the same phases; a phase above 2,000 ms is marked **Slow phase**. The server writes one structured `dataforge.query.timing` record per request, without SQL text, filter values, passwords, or connection secrets.

| Field              | What it measures                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `parseMs`          | Reading/validating the request JSON and query options. Expression parsing belongs to compile time.                                      |
| `compileMs`        | Loading/checking semantic metadata, resolving measure dependencies, and producing parameterized SQL.                                    |
| `cacheLookupMs`    | Finding and copying the current cached result.                                                                                          |
| `poolAcquireMs`    | Waiting for a connection from the bounded process-local query pool.                                                                     |
| `connectMs`        | Opening the pool's SQL connection/login/TLS path; a warm reused pool reports zero.                                                      |
| `sendToFirstRowMs` | Sending the request until its first row arrives; for an empty result, until completion. Includes SQL Server execution and network time. |
| `fetchMs`          | Receiving the remaining rows and completion response after the first row.                                                               |
| `totalMs`          | The current request's elapsed server time, including Node preparation and result handling.                                              |

Cache hits report fresh request timings, rather than the SQL duration saved with the original result. Their database phases are zero. `elapsedMs` now equals `timings.totalMs`, including Node preparation; the earlier elapsed timer started after compilation and measured only transport/driver work. `totalMs` can be larger than the sum of the displayed phases because it also includes response preparation and cleanup; these are server-side measurements, not the browser's entire network round trip.

Healthy connections are reused across uncached queries; DataForge does not create and close a SQL pool, TLS handshake, and login for every request. The pool admits at most four active queries and 16 queued queries; queue acquisition is capped at 30 seconds. A SQL request has a 30-second deadline, and timeout or AbortSignal cancellation explicitly calls `request.cancel()`. Cleanup waits up to five seconds for cancellation to settle; timed-out or unacknowledged connections are physically closed before their pool lease is released. A query using changed connection settings retires the previous pool. Idle pooled SQL sessions are expected; an active request must finish or be cancelled before its connection is reused.

Measure expansion is memoized by semantic version and measure identity, with bounded caches and cycle/dependency limits preserved. Shared base aggregates are emitted once per filter context, and derived scalar expressions read aggregate columns in an outer SELECT. Adding a ratio does not inline another copy of each referenced aggregate. The regression benchmark uses the Superstore semantic model and these cumulative sets:

1. Sales.
2. Sales and `Profit Margin % = DIVIDE([Profit], [Sales])`.
3. Add `Avg Order Value = DIVIDE([Sales], [Distinct Order ID])`.
4. Add `Sales % of Total = DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[Category])))`.
5. Add `Furniture Sales = CALCULATE([Sales], dim_product[Category] = 'Furniture')`.
6. All measures, including more than 30 definitions and their dependencies.

Run `pnpm test tests/semantic-query-performance.test.ts` without SQL Server. The compile budgets are 50 ms per cumulative set and 250 ms for the full set; profiling/fixture creation is outside the timed section. Separate structural tests prevent a measure reference from adding another fact-table source. These Node-only budgets do not establish the cause of a slow SQL Server request on another machine; use its timing phases to separate compilation, pool waiting, login, server execution, and result transfer.

The exact Product + Category regression selects Sales, `Sales % of Category = DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product])))`, and `Sales % of Grand Total = DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product]), ALL(dim_product[category])))`. It shares one Sales aggregate, then computes category and grand-total windows. The opt-in SQL Server test requires this warm, uncached query to finish in under 1,000 ms, including Node preparation. A separate local relational test executes the generated grouping/window SQL over all 2,000 sample rows, checks each result against independent sums, and enforces the same one-second local budget; it does not substitute for the live SQL Server measurement. Query requests accept up to 64 selected measures.

For a direct comparison, open [docs/query-timing.sql](docs/query-timing.sql) in SSMS using the same database/login as DataForge. It enables `SET STATISTICS TIME ON` and `SET STATISTICS IO ON`, includes runnable Superstore Category and Product + Category comparisons, and explains how to paste the exact generated SQL and typed parameter declarations. The Generated SQL drawer shows parameter names, types, and values separately, including for failed requests; values remain bound in the executed SQL. Enable **Include Actual Execution Plan** to inspect physical fact scans, row estimates, waits, spills, and implicit conversions. A single textual `FROM` or CTE does not by itself prove a single physical scan.

The generated row limit binds `@__df_limit` as SQL `INT`. Preserve the displayed parameter types in SSMS; check any `CONVERT_IMPLICIT` on filter/join columns before changing casts or indexes. Compare representative parameter values and actual plans before diagnosing parameter sniffing. DataForge does not add `OPTION (RECOMPILE)` speculatively; the SSMS guide shows how to use it only as a measured diagnostic.

### Columnstore

**Columnstore (recommended)** defaults on in Model and is persisted with the model. After fact loading, `04_fact.sql` ensures a clustered columnstore index and keeps the identity primary key nonclustered, upgrading an older generated clustered primary key when necessary. Incremental loads insert into the columnstore normally. Generated foreign-key rowstore indexes are retained only when columnstore is disabled. This changes the generated warehouse DDL; review the scripts and execute a new load to apply a changed setting.

The opt-in SQL Server integration test also compares each cumulative Sales/ratio/distinct-count/ALL/CALCULATE set by Category with independent fact-table SQL, checks timing fields and connection reuse, and examines the optimizer's physical plan for an extra fact access when adding Profit Margin %. It retains the YoY, Unknown-member, and three-dimension checks against the loaded Superstore sample. `SHOWPLAN_XML` needs database `SHOWPLAN` permission (included in the documented `db_owner` development setup). The test remains skipped unless the existing integration environment flag and SQL Server settings are supplied.
