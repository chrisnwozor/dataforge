import type { SemanticModel, SemanticTable } from "@/lib/semantic/types";
import type {
  CheckCase,
  CheckOutcome,
  CheckValue,
  PreparedColumnReference,
  PreparedReference,
  ReferenceExecutor,
  ReferenceSql,
  VerificationColumn,
  WarehouseLoadReference,
} from "./types";

export interface IngestionCheckInput {
  projectId: string;
  model: SemanticModel;
  prepared: PreparedReference;
  load: WarehouseLoadReference | null;
  reference: ReferenceExecutor;
  columns: VerificationColumn[];
  sourceFile?: string;
}
interface Tolerances {
  absolute: number;
  relative: number;
}
const defaults: Tolerances = { absolute: 0.01, relative: 0.000001 };
function quote(value: string): string {
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("A saved physical warehouse identifier is invalid.");
  return `[${value.replaceAll("]", "]]")}]`;
}
const comment = (value: string) =>
  value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
const qualified = (table: SemanticTable) =>
  `${quote(table.schema)}.${quote(table.sqlName)}`;
const result = (
  status: CheckOutcome["status"],
  expected: CheckValue,
  actual: CheckValue,
  explanation: string,
  sql: string,
  nextStep = "",
  difference: number | null = null,
  tolerance = 0,
): CheckOutcome => ({
  status,
  expected,
  actual,
  explanation,
  sql,
  referenceSql: sql,
  nextStep,
  difference,
  tolerance,
});
function number(value: unknown, label: string): number {
  if (
    (typeof value !== "number" &&
      typeof value !== "string" &&
      typeof value !== "bigint") ||
    value === ""
  )
    throw new Error(`Reference SQL did not return a numeric ${label}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Reference SQL returned a non-finite ${label}.`);
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
    throw new Error(
      `Reference SQL ${label} exceeds exact JavaScript integer precision.`,
    );
  return parsed;
}
function compare(
  expected: number | null,
  actual: number | null,
  sql: string,
  explanation: string,
  nextStep: string,
  tolerances: Tolerances = { absolute: 0, relative: 0 },
): CheckOutcome {
  const tolerance =
    expected === null
      ? 0
      : Math.max(tolerances.absolute, Math.abs(expected) * tolerances.relative);
  const difference =
    expected === null || actual === null ? null : actual - expected;
  const matches =
    expected === null || actual === null
      ? expected === actual
      : Math.abs(difference!) <= tolerance;
  return result(
    matches ? "pass" : "fail",
    expected,
    actual,
    explanation +
      (matches
        ? " The values reconcile."
        : " The independently calculated values do not match."),
    sql,
    matches ? "" : nextStep,
    difference,
    tolerance,
  );
}
function task(
  id: string,
  name: string,
  work: (signal: AbortSignal) => Promise<CheckOutcome>,
): CheckCase {
  return {
    id,
    area: "Ingestion",
    name,
    async run(signal) {
      signal.throwIfAborted();
      try {
        return await work(signal);
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        return result(
          "fail",
          null,
          {
            error:
              error instanceof Error
                ? error.message
                : "Reference query failed.",
          },
          "The independent ingestion reference could not finish; no passing result was substituted.",
          error && typeof error === "object" && "verifySql" in error
            ? String(error.verifySql)
            : "",
          "Inspect the reference query error, confirm the loaded objects still match the saved model, and rerun this check.",
        );
      }
    },
  };
}
function sqlQuery(
  sql: string,
  load: WarehouseLoadReference | null,
  limit = 1,
): ReferenceSql {
  return {
    sql,
    params: load
      ? [{ name: "__verify_run", value: load.id, type: "string" }]
      : [],
    columns: [],
    limit,
  };
}
async function reference(
  input: IngestionCheckInput,
  query: ReferenceSql,
  signal: AbortSignal,
) {
  try {
    return await input.reference(query, signal);
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error("Reference query failed.");
    throw Object.assign(failure, { verifySql: query.sql });
  }
}

const runPredicate = "[run_id] = CONVERT(UNIQUEIDENTIFIER, @__verify_run)";
function unavailable(
  load: WarehouseLoadReference | null,
  sql = "",
): CheckOutcome | null {
  return load
    ? null
    : result(
        "skipped",
        null,
        null,
        "There is no successful load to reconcile with this pinned prepared dataset.",
        sql,
        "Complete a successful load, then run Checks again.",
      );
}
function fullSnapshot(
  input: IngestionCheckInput,
  sql: string,
  rejectSensitive = true,
): CheckOutcome | null {
  if (!input.load) return unavailable(null, sql);
  if (input.load.mode === "incremental")
    return result(
      "skipped",
      null,
      null,
      "A full prepared snapshot cannot independently explain an incremental warehouse containing earlier loads and watermark exclusions.",
      sql,
      "Run a full refresh for prepared-to-warehouse reconciliation, or inspect the current run's eligible-row and rejection logs.",
    );
  if (rejectSensitive && input.load.rowsRejected > 0)
    return result(
      "skipped",
      null,
      null,
      "This load rejected rows. Whole-prepared-file aggregates include those rows; the exact accepted-row subset is not present in this reference, so it is not replaced with a guessed total.",
      sql,
      "Review the rejected-row check and reconcile a prepared dataset containing only accepted rows, or correct the rejects and run a full refresh.",
    );
  return null;
}
function sourceProfile(
  input: IngestionCheckInput,
  sourceId?: string,
  dedupe = true,
): PreparedColumnReference | undefined {
  const source = input.columns.find((column) => column.id === sourceId);
  return (
    dedupe && input.load?.dedupe
      ? input.prepared.deduplicatedColumns
      : input.prepared.columns
  ).find((column) => column.name === source?.name);
}
function unreliable(
  input: IngestionCheckInput,
  column: PreparedColumnReference,
): CheckOutcome | null {
  const warnings = input.prepared.warnings.filter((warning) =>
    warning.startsWith(`Column ${JSON.stringify(column.name)} `),
  );
  return warnings.length
    ? result(
        "skipped",
        null,
        null,
        warnings.join(" "),
        "",
        "Resolve invalid source values or numeric precision limits before comparing this column to the warehouse.",
      )
    : null;
}
function scalarDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  return match?.[0] ?? null;
}

/** Read-only SQL is deliberately handwritten from saved physical metadata. */
export function createIngestionChecks(
  input: IngestionCheckInput,
  toleranceOptions: Partial<Tolerances> = {},
): CheckCase[] {
  const tolerance = { ...defaults, ...toleranceOptions };
  if (
    !Number.isFinite(tolerance.absolute) ||
    tolerance.absolute < 0 ||
    !Number.isFinite(tolerance.relative) ||
    tolerance.relative < 0
  )
    throw new Error("Check tolerances must be finite and non-negative.");
  const fact = input.model.tables.find(
    (table) => table.id === input.model.factTableId && table.kind === "fact",
  );
  if (!fact)
    return [
      task("ingestion.metadata", "Saved warehouse metadata", async () =>
        result(
          "skipped",
          null,
          null,
          "The saved semantic metadata does not identify a physical fact table.",
          "",
          "Save a valid model and complete its first successful load.",
        ),
      ),
    ];
  const factSql = qualified(fact),
    checks: CheckCase[] = [];
  const stagedSql = `-- independent ingestion: prepared-to-staged\nSELECT TOP (1) [rows_in] AS [staged_rows]\nFROM [etl].[run_log]\nWHERE ${runPredicate} AND [step] = N'01_staging' AND [status] = N'Succeeded'\nORDER BY [finished_at] DESC, [started_at] DESC;`;
  checks.push(
    task(
      "ingestion.rows.prepared-staged",
      "Prepared source rows equal staged rows",
      async (signal) => {
        const missing = unavailable(input.load, stagedSql);
        if (missing) return missing;
        const rows = await reference(
          input,
          sqlQuery(stagedSql, input.load),
          signal,
        );
        if (!rows.length)
          return result(
            "fail",
            input.prepared.rows,
            null,
            "SQL Server has no successful staging log for this load ID.",
            stagedSql,
            "Inspect 01_staging.sql and the selected load's ETL log; rerun the load before checking.",
          );
        return compare(
          input.prepared.rows,
          number(rows[0].staged_rows, "staged row count"),
          stagedSql,
          "The prepared CSV was counted in a separate streaming Node pass and is compared with SQL Server's staging-step log.",
          "Inspect the pinned prepared CSV, BULK INSERT row terminators, and staging-step log for skipped or extra rows.",
        );
      },
    ),
  );
  checks.push(
    task(
      "ingestion.rows.summary",
      "Saved staging summary matches SQL Server",
      async (signal) => {
        const missing = unavailable(input.load, stagedSql);
        if (missing) return missing;
        const rows = await reference(
          input,
          sqlQuery(stagedSql, input.load),
          signal,
        );
        return compare(
          input.load!.rowsStaged,
          rows.length ? number(rows[0].staged_rows, "staged row count") : null,
          stagedSql,
          "The SQLite run summary is checked against the independently read SQL Server ETL record.",
          "Inspect run-summary capture and the SQL Server ETL log for this run ID.",
        );
      },
    ),
  );
  const balanceSql = `-- independent ingestion: row balance\nSELECT (SELECT COUNT_BIG(*) FROM ${factSql}) AS [fact_rows],\n       (SELECT COUNT_BIG(*) FROM [dw].[reject_rows] WHERE ${runPredicate}) AS [rejected_rows];`;
  checks.push(
    task(
      "ingestion.rows.balance",
      "Staged rows reconcile to facts, rejects and duplicates",
      async (signal) => {
        const skipped = fullSnapshot(input, balanceSql, false);
        if (skipped) return skipped;
        const [row] = await reference(
          input,
          sqlQuery(balanceSql, input.load),
          signal,
        );
        if (!row)
          throw new Error("The independent row-balance query returned no row.");
        const facts = number(row.fact_rows, "fact row count"),
          rejects = number(row.rejected_rows, "rejected row count"),
          duplicates = input.load!.dedupe ? input.prepared.duplicateRows : 0;
        const actual = facts + rejects + duplicates,
          outcome = compare(
            input.prepared.rows,
            actual,
            balanceSql,
            `Prepared rows = ${facts} current fact rows + ${rejects} rejected rows + ${duplicates} independently counted exact duplicates removed.`,
            "Inspect rejected-row reasons, the duplicate-removal toggle, and fact inserts; the compiler/generator has not been changed to force this equation.",
          );
        return {
          ...outcome,
          actual: {
            reconciledRows: actual,
            factRows: facts,
            rejectedRows: rejects,
            removedDuplicates: duplicates,
          },
        };
      },
    ),
  );
  const factCountSql = `-- independent ingestion: fact row count\nSELECT COUNT_BIG(*) AS [fact_rows] FROM ${factSql};`;
  checks.push(
    task(
      "ingestion.rows.fact-summary",
      "Loaded row summary equals the full fact table",
      async (signal) => {
        const skipped = fullSnapshot(input, factCountSql, false);
        if (skipped) return skipped;
        const [row] = await reference(
          input,
          sqlQuery(factCountSql, input.load),
          signal,
        );
        return compare(
          input.load!.rowsLoaded,
          row ? number(row.fact_rows, "fact row count") : null,
          factCountSql,
          "A direct COUNT_BIG of the current fact is compared with the saved full-load summary.",
          "Inspect fact writes after the load and the row-count summary captured from etl.run_log.",
        );
      },
    ),
  );
  const factKey = fact.columns.find((column) => column.id === fact.keyColumnId);
  for (const column of fact.columns.filter((column) => column.role === "key")) {
    const sql = `-- independent ingestion: null key ${comment(column.id)}\nSELECT COUNT_BIG(*) AS [null_keys] FROM ${factSql} WHERE ${quote(column.sqlName)} IS NULL;`;
    checks.push(
      task(
        `ingestion.key.null.${column.id}`,
        `No NULL keys: ${column.name}`,
        async (signal) => {
          const skipped = unavailable(input.load, sql);
          if (skipped) return skipped;
          const [row] = await reference(input, sqlQuery(sql, null), signal);
          return compare(
            0,
            row ? number(row.null_keys, "NULL-key count") : null,
            sql,
            "Primary and foreign keys must remain populated; missing dimension members use the explicit Unknown key (-1).",
            "Inspect fact key defaults, source mappings and the load's dimension joins.",
          );
        },
      ),
    );
  }
  if (!factKey)
    checks.push(
      task("ingestion.key.metadata", "Fact key metadata exists", async () =>
        result(
          "fail",
          "A saved fact key column",
          null,
          "The fact table's keyColumnId does not identify a saved column.",
          "",
          "Repair the saved physical fact-key mapping before loading again.",
        ),
      ),
    );
  for (const column of fact.columns.filter(
    (column) => column.role === "measure-source" || column.role === "attribute",
  )) {
    const profile = sourceProfile(input, column.sourceColumnId);
    if (!profile) continue;
    const sql = `-- independent ingestion: values ${comment(column.id)}\nSELECT COUNT_BIG(*) - COUNT_BIG(${quote(column.sqlName)}) AS [null_cells]${column.type === "number" ? `, SUM(CAST(${quote(column.sqlName)} AS DECIMAL(38,6))) AS [sum_value], MIN(${quote(column.sqlName)}) AS [min_value], MAX(${quote(column.sqlName)}) AS [max_value]` : ""}\nFROM ${factSql};`;
    checks.push(
      task(
        `ingestion.column.null.${column.id}`,
        `Prepared NULL count: ${column.name}`,
        async (signal) => {
          const skipped =
            fullSnapshot(input, sql) ?? unreliable(input, profile);
          if (skipped) return { ...skipped, sql, referenceSql: sql };
          const [row] = await reference(input, sqlQuery(sql, null), signal);
          return compare(
            profile.nulls,
            row ? number(row.null_cells, "NULL-cell count") : null,
            sql,
            "NULL/empty prepared values were counted independently, using the load's exact-deduplication setting.",
            "Inspect type conversion, NULL handling, rejected rows and the prepared snapshot for this column.",
          );
        },
      ),
    );
    if (column.type !== "number" || !profile.numeric) continue;
    for (const [aggregation, field] of [
      ["SUM", "sum_value"],
      ["MIN", "min_value"],
      ["MAX", "max_value"],
    ] as const) {
      const expected =
        profile.numeric.count === 0
          ? null
          : aggregation === "SUM"
            ? profile.numeric.sum
            : aggregation === "MIN"
              ? profile.numeric.min
              : profile.numeric.max;
      checks.push(
        task(
          `ingestion.numeric.${aggregation.toLowerCase()}.${column.id}`,
          `${column.name}: fact ${aggregation} equals prepared ${aggregation}`,
          async (signal) => {
            const skipped =
              fullSnapshot(input, sql) ?? unreliable(input, profile);
            if (skipped) return { ...skipped, sql, referenceSql: sql };
            const [row] = await reference(input, sqlQuery(sql, null), signal);
            if (!row)
              throw new Error(
                "The independent numeric reference returned no row.",
              );
            const value =
              row[field] === null
                ? null
                : number(row[field], `${aggregation} value`);
            return compare(
              expected,
              value,
              sql,
              `The fact's ${aggregation} is compared with a separate streaming decimal calculation over ${input.load!.dedupe ? "exactly-once" : "all"} prepared rows. Saved measure aggregations do not change the source-row grain stored in the fact.`,
              "Inspect numeric conversion/rounding, the pinned prepared snapshot, and rejected rows. A mismatch is reported without changing generator logic.",
              tolerance,
            );
          },
        ),
      );
    }
  }
  for (const relationship of input.model.relationships.filter(
    (relationship) => relationship.fromTableId === fact.id,
  )) {
    const table = input.model.tables.find(
        (table) => table.id === relationship.toTableId,
      ),
      foreignKey = fact.columns.find(
        (column) => column.id === relationship.fromColumnId,
      ),
      key = table?.columns.find(
        (column) => column.id === relationship.toColumnId,
      );
    if (!table || !foreignKey || !key) {
      checks.push(
        task(
          `ingestion.relationship.${relationship.id}`,
          "Dimension relationship metadata",
          async () =>
            result(
              "fail",
              "Valid saved relationship columns",
              null,
              "A relationship refers to a missing table or physical key column.",
              "",
              "Repair the saved semantic relationship and reload the model.",
            ),
        ),
      );
      continue;
    }
    const tableSql = qualified(table);
    const orphanSql = `-- independent ingestion: orphan keys ${comment(relationship.id)}\nSELECT COUNT_BIG(*) AS [orphan_keys]\nFROM ${factSql} AS [f] LEFT JOIN ${tableSql} AS [d] ON [f].${quote(foreignKey.sqlName)} = [d].${quote(key.sqlName)}\nWHERE [f].${quote(foreignKey.sqlName)} IS NOT NULL AND [d].${quote(key.sqlName)} IS NULL;`;
    checks.push(
      task(
        `ingestion.key.orphan.${relationship.id}`,
        `No orphan keys: ${table.name}`,
        async (signal) => {
          const skipped = unavailable(input.load, orphanSql);
          if (skipped) return skipped;
          const [row] = await reference(
            input,
            sqlQuery(orphanSql, null),
            signal,
          );
          return compare(
            0,
            row ? number(row.orphan_keys, "orphan-key count") : null,
            orphanSql,
            "A separate LEFT JOIN verifies that every populated fact foreign key resolves to an existing dimension member.",
            "Inspect foreign-key constraints, dimension loading and deleted members; do not replace orphan keys silently.",
          );
        },
      ),
    );
    const unknownSql = `-- independent ingestion: Unknown counts ${comment(relationship.id)}\nSELECT (SELECT COUNT_BIG(*) FROM ${tableSql} WHERE ${quote(key.sqlName)} = -1) AS [unknown_members],\n       (SELECT COUNT_BIG(*) FROM ${factSql} WHERE ${quote(foreignKey.sqlName)} = -1) AS [unknown_facts];`;
    checks.push(
      task(
        `ingestion.unknown.${relationship.id}`,
        `Unknown-member usage: ${table.name}`,
        async (signal) => {
          const skipped = unavailable(input.load, unknownSql);
          if (skipped) return skipped;
          const [row] = await reference(
            input,
            sqlQuery(unknownSql, null),
            signal,
          );
          if (!row)
            throw new Error(
              "The independent Unknown-member query returned no row.",
            );
          const members = number(
              row.unknown_members,
              "Unknown dimension-member count",
            ),
            facts = number(row.unknown_facts, "Unknown fact-row count");
          return result(
            members !== 1 ? "fail" : facts ? "warn" : "pass",
            { unknownMembers: 1, unknownFacts: 0 },
            { unknownMembers: members, unknownFacts: facts },
            `The dimension has ${members} Unknown member(s), and ${facts} fact row(s) use key -1. Unknown rows are visible in the check report rather than removed from reconciliation.`,
            unknownSql,
            members !== 1
              ? "Restore exactly one Unknown member with key -1 before loading."
              : facts
                ? "Review missing business keys and dates in Sources/Prepare, or accept the explicitly reported Unknown-member mapping."
                : "",
            facts,
            0,
          );
        },
      ),
    );
    const isCalendar = input.model.date?.tableId === table.id;
    const business = sourceProfile(input, foreignKey.sourceColumnId, false);
    const dimensionSql = `-- independent ingestion: dimension count ${comment(table.id)}\nSELECT COUNT_BIG(*) AS [dimension_rows] FROM ${tableSql};`;
    if (!isCalendar)
      checks.push(
        task(
          `ingestion.dimension.rows.${table.id}`,
          `Distinct prepared keys plus Unknown: ${table.name}`,
          async (signal) => {
            const skipped = unavailable(input.load, dimensionSql);
            if (skipped) return skipped;
            if (!business)
              return result(
                "skipped",
                null,
                null,
                "The saved physical metadata does not identify this dimension's prepared business-key column.",
                dimensionSql,
                "Save a source-column mapping for the dimension business key and run a full load.",
              );
            const invalid = unreliable(input, business);
            if (invalid)
              return {
                ...invalid,
                sql: dimensionSql,
                referenceSql: dimensionSql,
              };
            const [row] = await reference(
              input,
              sqlQuery(dimensionSql, null),
              signal,
            );
            return compare(
              business.distinct + 1,
              row ? number(row.dimension_rows, "dimension row count") : null,
              dimensionSql,
              `Independent distinct values of ${JSON.stringify(business.name)} plus one Unknown member are compared with the dimension row count.`,
              "Inspect business-key mappings, functional dependencies and retained historical dimension members; a full fact refresh preserves descriptive dimension members.",
            );
          },
        ),
      );
    if (!isCalendar)
      for (const column of table.columns.filter(
        (column) => column.role === "attribute" && column.sourceColumnId,
      )) {
        const profile = sourceProfile(input, column.sourceColumnId, false);
        if (!profile) continue;
        const sql = `-- independent ingestion: dimension distinct ${comment(column.id)}\nSELECT COUNT_BIG(DISTINCT ${quote(column.sqlName)}) AS [distinct_values] FROM ${tableSql} WHERE ${quote(key.sqlName)} <> -1;`;
        checks.push(
          task(
            `ingestion.dimension.distinct.${column.id}`,
            `Prepared distinct values: ${table.name}[${column.name}]`,
            async (signal) => {
              const skipped = unavailable(input.load, sql);
              if (skipped) return skipped;
              const invalid = unreliable(input, profile);
              if (invalid) return { ...invalid, sql, referenceSql: sql };
              if (
                column.type === "string" &&
                profile.nulls &&
                column.sourceColumnId !== foreignKey.sourceColumnId
              )
                return result(
                  "skipped",
                  profile.distinct,
                  null,
                  "NULL descriptive text may be filled with the literal Unknown during the dimension merge. A count alone cannot distinguish that generated value from a real source value named Unknown.",
                  sql,
                  "Inspect the prepared NULLs and loaded attribute values, or fill them explicitly before loading for exact distinct-count reconciliation.",
                );
              const [row] = await reference(input, sqlQuery(sql, null), signal);
              return compare(
                profile.distinct,
                row
                  ? number(
                      row.distinct_values,
                      "dimension attribute distinct count",
                    )
                  : null,
                sql,
                "Independently counted non-empty prepared attribute values are compared with known dimension members only; the surrogate Unknown row is excluded.",
                "Inspect retained dimension members, missing-key rows and business-key functional dependencies that may collapse attribute values.",
              );
            },
          ),
        );
      }
    if (isCalendar) {
      const dateColumn = table.columns.find(
        (column) => column.id === input.model.date?.dateColumnId,
      );
      const dates = sourceProfile(input, foreignKey.sourceColumnId, false);
      if (!dateColumn) continue;
      const min = scalarDate(dates?.min),
        max = scalarDate(dates?.max);
      const sql = `-- independent ingestion: calendar coverage ${comment(table.id)}\nSELECT MIN(${quote(dateColumn.sqlName)}) AS [min_date], MAX(${quote(dateColumn.sqlName)}) AS [max_date],\n       COUNT_BIG(DISTINCT CASE WHEN ${quote(dateColumn.sqlName)} BETWEEN CONVERT(DATE, @__verify_min, 23) AND CONVERT(DATE, @__verify_max, 23) THEN ${quote(dateColumn.sqlName)} END) AS [covered_dates]\nFROM ${tableSql} WHERE ${quote(key.sqlName)} <> -1;`;
      checks.push(
        task(
          `ingestion.date.coverage.${table.id}`,
          `Calendar covers every prepared date: ${table.name}`,
          async (signal) => {
            const skipped = unavailable(input.load, sql);
            if (skipped) return skipped;
            if (!min || !max || !dates)
              return result(
                "skipped",
                null,
                null,
                "The prepared date source has no valid observed date range, or its saved source mapping is unavailable.",
                sql,
                "Supply valid source dates and a calendar source mapping, then reload.",
              );
            const invalid = unreliable(input, dates);
            if (invalid) return { ...invalid, sql, referenceSql: sql };
            const query = sqlQuery(sql, null);
            query.params = [
              { name: "__verify_min", value: min, type: "date" },
              { name: "__verify_max", value: max, type: "date" },
            ];
            const [row] = await reference(input, query, signal);
            if (!row)
              throw new Error("The calendar coverage query returned no row.");
            const actualMin = scalarDate(row.min_date),
              actualMax = scalarDate(row.max_date),
              covered = number(row.covered_dates, "covered calendar dates"),
              days =
                Math.round(
                  (Date.parse(`${max}T00:00:00Z`) -
                    Date.parse(`${min}T00:00:00Z`)) /
                    86400_000,
                ) + 1;
            const matches =
              actualMin !== null &&
              actualMax !== null &&
              actualMin <= min &&
              actualMax >= max &&
              covered === days;
            return result(
              matches ? "pass" : "fail",
              { min, max, consecutiveDays: days },
              { min: actualMin, max: actualMax, coveredDates: covered },
              "The calendar must cover the complete independently observed source-date range, including days without fact rows; padded calendar years are allowed.",
              sql,
              matches
                ? ""
                : "Inspect missing calendar dates and the saved source-date relationship, then rerun the calendar/load step.",
              covered - days,
            );
          },
        ),
      );
    }
  }
  const rejectCountSql = `-- independent ingestion: rejected row count\nSELECT COUNT_BIG(*) AS [rejected_rows] FROM [dw].[reject_rows] WHERE ${runPredicate};`;
  const reasonsSql = `-- independent ingestion: rejected reasons\nSELECT TOP (101) [reason], COUNT_BIG(*) AS [rejected_rows] FROM [dw].[reject_rows]\nWHERE ${runPredicate}\nGROUP BY [reason] ORDER BY [rejected_rows] DESC, [reason];`;
  const rejectedRowsSql = `-- independent ingestion: rejected row examples\nSELECT TOP (100) [source_row_number], [reason] FROM [dw].[reject_rows]\nWHERE ${runPredicate}\nORDER BY [source_row_number], [reason];`;
  checks.push(
    task("ingestion.rejects", "Rejected rows and reasons", async (signal) => {
      const sql = [rejectCountSql, reasonsSql, rejectedRowsSql].join("\n\n"),
        skipped = unavailable(input.load, sql);
      if (skipped) return skipped;
      const [count] = await reference(
        input,
        sqlQuery(rejectCountSql, input.load),
        signal,
      );
      if (!count) throw new Error("The rejected-row count returned no row.");
      const total = number(count.rejected_rows, "rejected row count");
      const reasons = total
        ? await reference(input, sqlQuery(reasonsSql, input.load, 101), signal)
        : [];
      const examples = total
        ? await reference(
            input,
            sqlQuery(rejectedRowsSql, input.load, 100),
            signal,
          )
        : [];
      const summaryMatches = input.load!.rowsRejected === total;
      return result(
        !summaryMatches ? "fail" : total ? "warn" : "pass",
        { rejectedRows: input.load!.rowsRejected },
        {
          rejectedRows: total,
          reasons: reasons.slice(0, 100).map((row) => ({
            reason: String(row.reason ?? "Unspecified"),
            count: number(row.rejected_rows, "rejected rows for reason"),
          })),
          rows: examples.map((row) => ({
            rowNumber: number(
              row.source_row_number,
              "rejected source row number",
            ),
            reason: String(row.reason ?? "Unspecified"),
          })),
          truncatedReasons: reasons.length > 100,
          truncatedRows: total > examples.length,
        },
        summaryMatches
          ? total
            ? "The load's rejected rows are shown by reason and logical source row number. Rejections are not hidden by aggregate tolerances."
            : "SQL Server reports no rejected rows for this load."
          : "The live rejected-row count differs from the SQLite load summary.",
        sql,
        !summaryMatches
          ? "Inspect run-summary capture and the reject table for this exact load ID."
          : total
            ? "Correct the listed source rows or add explicit Prepare quality rules before running another load."
            : "",
        total - input.load!.rowsRejected,
      );
    }),
  );
  if (input.prepared.warnings.length)
    checks.push(
      task(
        "ingestion.prepared-warnings",
        "Independent prepared-reference warnings",
        async () =>
          result(
            "warn",
            "Valid typed source values with exact numeric references",
            input.prepared.warnings,
            "The independent CSV pass found values that need review; affected comparisons are skipped explicitly rather than made to pass.",
            "",
            "Review the named source columns, type settings, precision limits and rejected rows.",
          ),
      ),
    );
  return checks;
}
