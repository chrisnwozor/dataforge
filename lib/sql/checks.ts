import type { GeneratedFile, SqlContext } from "./types";
import {
  commentText,
  qualified,
  quoteIdentifier,
  sqlLiteral,
  wrapStep,
} from "./helpers";

export function checksFile(context: SqlContext): GeneratedFile {
  const stage = qualified("stg", context.stageTable);
  const fact = qualified("dw", context.factTable);
  const hasPersistedDate =
    context.foreignKeys.some(
      (key) =>
        (key.dimension.model.generated === "date" && key.source !== null) ||
        (key.dimension.model.generated !== "date" &&
          key.dimension.businessKey !== null &&
          (key.dimension.businessKey.source.overrideType ??
            key.dimension.businessKey.source.inferredType) === "date"),
    ) ||
    context.degenerates.some(
      (column) =>
        (column.source.overrideType ?? column.source.inferredType) === "date",
    );
  const incremental = context.input.options.incremental && hasPersistedDate;
  const orphanQueries = context.foreignKeys.map(
    (
      key,
      index,
    ) => `  SELECT ${sqlLiteral(key.name)} AS [foreign_key], COUNT_BIG(*) AS [orphan_count]
  FROM ${fact} AS [f]
  LEFT JOIN ${qualified("dw", key.dimension.table)} AS ${quoteIdentifier(`d${index}`)} ON [f].${quoteIdentifier(key.name)} = ${quoteIdentifier(`d${index}`)}.${quoteIdentifier(key.dimension.key)}
  WHERE ${quoteIdentifier(`d${index}`)}.${quoteIdentifier(key.dimension.key)} IS NULL;`,
  );
  const nullQueries = [
    context.factKey,
    ...context.foreignKeys.map((key) => key.name),
  ].map(
    (key) =>
      `  SELECT ${sqlLiteral(key)} AS [key_column], COUNT_BIG(*) AS [null_key_count] FROM ${fact} WHERE ${quoteIdentifier(key)} IS NULL;`,
  );
  const aggregations = context.measures.map((measure) => {
    const column = `[f].${quoteIdentifier(measure.name)}`;
    const expression =
      measure.model.aggregation === "AVG" || measure.model.aggregation === "SUM"
        ? `${measure.model.aggregation}(CAST(${column} AS DECIMAL(38, 6)))`
        : `${measure.model.aggregation}(${column})`;
    return `  -- ${commentText(measure.name)}: ${measure.model.aggregation} (${measure.model.additivity}).\n  SELECT ${sqlLiteral(measure.name)} AS [measure], ${sqlLiteral(measure.model.aggregation)} AS [aggregation], ${expression} AS [value] FROM ${fact} AS [f];`;
  });
  const body = `  DECLARE @StagingRows BIGINT = (SELECT COUNT_BIG(*) FROM ${stage});
  DECLARE @FactRows BIGINT = (SELECT COUNT_BIG(*) FROM ${fact});
  DECLARE @EligibleRows BIGINT = NULL, @LoadedRows BIGINT = NULL, @LoggedRejected BIGINT = NULL;
  SELECT TOP (1) @EligibleRows = [rows_in], @LoadedRows = [rows_out], @LoggedRejected = [rows_rejected]
  FROM [etl].[run_log]
  WHERE [run_id] = @RunId AND [step] = N'04_fact' AND [status] = N'Succeeded'
  ORDER BY [finished_at] DESC, [started_at] DESC;
  DECLARE @RejectedRows BIGINT = (SELECT COUNT_BIG(*) FROM [dw].[reject_rows] WHERE [run_id] = @RunId);
  -- In incremental mode, compare this run's inserts to eligible staging rows; total fact rows include earlier runs.
  -- Excluded rows are exact duplicates and/or rows at or before the incremental date watermark.
  SELECT @RunId AS [run_id], @StagingRows AS [staging_rows], @FactRows AS [total_fact_rows],
    @EligibleRows AS [eligible_staging_rows], @StagingRows - @EligibleRows AS [excluded_source_rows],
    @LoadedRows AS [facts_inserted_this_run], @RejectedRows AS [rejected_this_run],
    CAST(CASE WHEN @EligibleRows = @LoadedRows + @RejectedRows AND @RejectedRows = @LoggedRejected${incremental ? "" : " AND @FactRows = @LoadedRows"} THEN 1 ELSE 0 END AS BIT) AS [row_counts_reconcile];
${orphanQueries.join("\n")}
${nullQueries.join("\n")}
  SELECT TOP (10) [run_id], [source_row_number], [reason], [raw_json]
  FROM [dw].[reject_rows] WHERE [run_id] = @RunId ORDER BY [source_row_number];
  -- Saved measure aggregations are query recommendations; fact inserts retain the source grain.
${aggregations.join("\n")}
  SET @RowsIn = @StagingRows;
  SET @RowsOut = @FactRows;
  SET @RowsRejected = @RejectedRows;`;
  return {
    name: "05_checks.sql",
    description:
      "Reconciles eligible staging rows with inserted facts and rejected rows, then checks keys. Shows rejected examples and applies the saved measure aggregations for review.",
    sql: wrapStep(context, "05_checks", body),
  };
}
