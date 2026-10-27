import {
  commentText,
  converted,
  qualified,
  quoteIdentifier,
  sourceRaw,
  sqlLiteral,
  uniqueIdentifier,
  wrapStep,
} from "./helpers";
import type {
  GeneratedFile,
  PreparedColumn,
  SqlColumn,
  SqlContext,
} from "./types";

function valueAlias(column: SqlColumn): string {
  return `__df_value_${column.ordinal}`;
}

function storageType(column: PreparedColumn): string {
  return column.type.startsWith("NVARCHAR")
    ? `${column.type} COLLATE Latin1_General_100_BIN2`
    : column.type;
}

/** A fact keeps the saved model's source-row grain; aggregations remain query metadata. */
export function factFile(context: SqlContext): GeneratedFile {
  const fact = qualified("dw", context.factTable);
  const stage = qualified("stg", context.stageTable);
  const sourceColumns = [...context.columns.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const usedObjects = new Set<string>();
  const primaryKey = uniqueIdentifier(`pk_${context.factTable}`, usedObjects);
  const factColumns = [
    ...context.foreignKeys.map((key) => key.name),
    ...context.degenerates.map((column) => column.name),
    ...context.measures.map((column) => column.name),
  ];
  if (!factColumns.length)
    throw new Error("Assign source columns to the fact before generating SQL.");

  const definitions = [
    `    ${quoteIdentifier(context.factKey)} INT IDENTITY(1, 1) NOT NULL CONSTRAINT ${quoteIdentifier(primaryKey)} PRIMARY KEY`,
    ...context.foreignKeys.map(
      (key) => `    ${quoteIdentifier(key.name)} INT NOT NULL DEFAULT (-1)`,
    ),
    ...context.degenerates.map(
      (column) =>
        `    ${quoteIdentifier(column.name)} ${storageType(column)} NULL`,
    ),
    ...context.measures.map(
      (column) =>
        `    ${quoteIdentifier(column.name)} ${storageType(column)} NULL`,
    ),
  ];
  const create = `  IF OBJECT_ID(${sqlLiteral(fact)}, N'U') IS NULL\n  BEGIN\n    CREATE TABLE ${fact} (\n${definitions.join(",\n")}\n    );\n  END;`;
  const constraints = context.foreignKeys.map((key) => {
    const name = uniqueIdentifier(
      `fk_${context.factTable}_${key.name}`,
      usedObjects,
    );
    const index = uniqueIdentifier(
      `ix_${context.factTable}_${key.name}`,
      usedObjects,
    );
    return `  IF NOT EXISTS (SELECT 1 FROM [sys].[foreign_keys] WHERE [parent_object_id] = OBJECT_ID(${sqlLiteral(fact)}) AND [name] = ${sqlLiteral(name)})\n    ALTER TABLE ${fact} WITH CHECK ADD CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${quoteIdentifier(key.name)}) REFERENCES ${qualified("dw", key.dimension.table)} (${quoteIdentifier(key.dimension.key)});\n  IF NOT EXISTS (SELECT 1 FROM [sys].[indexes] WHERE [object_id] = OBJECT_ID(${sqlLiteral(fact)}) AND [name] = ${sqlLiteral(index)})\n    CREATE NONCLUSTERED INDEX ${quoteIdentifier(index)} ON ${fact} (${quoteIdentifier(key.name)});`;
  });

  const calendarKey = context.foreignKeys.find(
    (key) => key.dimension.model.generated === "date" && key.source !== null,
  );
  // A date business key is stable across dimension MERGEs. Date attributes are
  // mutable and cannot safely supply a watermark after those MERGEs run.
  const datedBusinessKey = context.foreignKeys.find((key) => {
    const source = key.dimension.businessKey?.source;
    return (
      key.dimension.model.generated !== "date" &&
      source !== undefined &&
      (source.overrideType ?? source.inferredType) === "date"
    );
  });
  const factDate = context.degenerates.find(
    (column) =>
      (column.source.overrideType ?? column.source.inferredType) === "date",
  );
  const watermarkSource =
    calendarKey?.source ??
    datedBusinessKey?.dimension.businessKey?.source ??
    factDate?.source ??
    null;
  if (
    context.input.options.incremental &&
    context.dateColumns.length > 0 &&
    watermarkSource === null
  )
    throw new Error(
      "Incremental loading requires a persisted calendar link, date business key, or fact date identifier. Assign a source date or select full refresh.",
    );
  const incremental =
    context.input.options.incremental && watermarkSource !== null;
  const mode = incremental
    ? "  -- Incremental mode retains existing facts and loads dates strictly after the watermark."
    : context.input.options.incremental
      ? "  -- No persisted date relationship is available; incremental mode falls back to a full refresh."
      : "  -- Full refresh replaces the fact, while descriptive dimension members remain available.";
  const watermark = incremental
    ? calendarKey
      ? `  DECLARE @Watermark DATE = (SELECT MAX([calendar].[Date]) FROM ${fact} AS [loaded] INNER JOIN ${qualified("dw", calendarKey.dimension.table)} AS [calendar] ON [loaded].${quoteIdentifier(calendarKey.name)} = [calendar].${quoteIdentifier(calendarKey.dimension.key)} WHERE [calendar].${quoteIdentifier(calendarKey.dimension.key)} <> -1);`
      : datedBusinessKey
        ? `  DECLARE @Watermark DATE = (SELECT MAX([loaded_date_dim].${quoteIdentifier(datedBusinessKey.dimension.businessKey!.name)}) FROM ${fact} AS [loaded] INNER JOIN ${qualified("dw", datedBusinessKey.dimension.table)} AS [loaded_date_dim] ON [loaded].${quoteIdentifier(datedBusinessKey.name)} = [loaded_date_dim].${quoteIdentifier(datedBusinessKey.dimension.key)} WHERE [loaded_date_dim].${quoteIdentifier(datedBusinessKey.dimension.key)} <> -1);`
        : `  DECLARE @Watermark DATE = (SELECT MAX(${quoteIdentifier(factDate!.name)}) FROM ${fact});`
    : `  TRUNCATE TABLE ${fact};`;

  const rawProjection = [
    ...sourceColumns.map(
      (column) =>
        `[s].${quoteIdentifier(context.stageColumns.get(String(column.ordinal))!)}`,
    ),
    "[s].[source_row_number]",
  ].join(", ");
  const partition = sourceColumns
    .map(
      (column) =>
        `${sourceRaw(context, String(column.ordinal))} COLLATE Latin1_General_100_BIN2`,
    )
    .join(", ");
  const source = context.input.options.dedupe
    ? `  -- Exact duplicates use the profiler's trimmed, empty-as-NULL source values.\n  ;WITH [ranked_source] AS (\n    SELECT [s].*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY [s].[source_row_number]) AS [__df_duplicate_rank]\n    FROM ${stage} AS [s]\n  )\n  SELECT ${rawProjection}\n  INTO [#DF_Source]\n  FROM [ranked_source] AS [s]\n  WHERE [s].[__df_duplicate_rank] = 1;`
    : `  -- Duplicate removal is off: every staging row remains a source observation.\n  SELECT ${rawProjection}\n  INTO [#DF_Source]\n  FROM ${stage} AS [s];`;

  const conversions = new Map<string, SqlColumn>();
  for (const column of [
    ...context.measures.map((measure) => measure.source),
    ...context.degenerates.map((dimension) => dimension.source),
    ...context.dateColumns,
    ...context.foreignKeys.flatMap((key) =>
      key.dimension.model.generated === "date"
        ? key.source
          ? [key.source]
          : []
        : key.dimension.businessKey
          ? [key.dimension.businessKey.source]
          : [],
    ),
  ])
    conversions.set(String(column.ordinal), column);
  const conversionProjection = [...conversions.values()].map(
    (column) =>
      `${converted(context, column)} AS ${quoteIdentifier(valueAlias(column))}`,
  );
  const required = new Map<string, { column: SqlColumn; kind: string }>();
  for (const measure of context.measures)
    required.set(String(measure.source.ordinal), {
      column: measure.source,
      kind: "Invalid measure",
    });
  for (const column of context.dateColumns)
    required.set(String(column.ordinal), { column, kind: "Invalid date" });
  const reasons = [...required.values()].map(({ column, kind }) => {
    const name =
      context.input.model.columnNames[String(column.ordinal)] || column.name;
    return `CASE WHEN ${sourceRaw(context, String(column.ordinal))} IS NOT NULL AND ${converted(context, column)} IS NULL THEN ${sqlLiteral(`${kind}: ${name.slice(0, 128)}; `)} ELSE N'' END`;
  });
  const rejectReason = reasons.length
    ? `CAST(N'' AS NVARCHAR(MAX)) + ${reasons.join(" + ")}`
    : "CAST(N'' AS NVARCHAR(MAX))";
  const candidates = `  SELECT [s].*,\n    ${[...conversionProjection, `${rejectReason} AS [__df_reject_reason]`].join(",\n    ")}\n  INTO [#DF_Candidates]\n  FROM [#DF_Source] AS [s];`;
  const eligible = incremental
    ? `\n  -- Invalid non-empty dates stay eligible for rejection; missing dates map to Unknown only on the initial load.\n  DELETE FROM [#DF_Candidates]\n  WHERE @Watermark IS NOT NULL AND (\n    ${quoteIdentifier(valueAlias(watermarkSource!))} <= @Watermark\n    OR (${quoteIdentifier(valueAlias(watermarkSource!))} IS NULL AND ${sourceRaw(context, String(watermarkSource!.ordinal), "#DF_Candidates")} IS NULL)\n  );`
    : "";

  const rawJson = sourceColumns
    .map((column) => {
      const name = context.stageColumns.get(String(column.ordinal))!;
      return `[s].${quoteIdentifier(name)} AS ${quoteIdentifier(name)}`;
    })
    .join(", ");
  const reject = `  SET @RowsIn = (SELECT COUNT_BIG(*) FROM [#DF_Candidates]);\n  DELETE FROM [dw].[reject_rows] WHERE [run_id] = @RunId;\n  INSERT INTO [dw].[reject_rows] ([run_id], [source_row_number], [reason], [raw_json])\n  SELECT @RunId, [s].[source_row_number], [s].[__df_reject_reason],\n    (SELECT ${rawJson} FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER)\n  FROM [#DF_Candidates] AS [s]\n  WHERE [s].[__df_reject_reason] <> N'';\n  SET @RowsRejected = @@ROWCOUNT;`;

  const joins: string[] = [];
  const foreignValues = context.foreignKeys.map((key, index) => {
    const alias = `dimension_${index + 1}`;
    const target = qualified("dw", key.dimension.table);
    const keyColumn = `${quoteIdentifier(alias)}.${quoteIdentifier(key.dimension.key)}`;
    if (key.dimension.model.generated === "date" && key.source) {
      joins.push(
        `  LEFT JOIN ${target} AS ${quoteIdentifier(alias)} ON ${quoteIdentifier(alias)}.[Date] = [s].${quoteIdentifier(valueAlias(key.source))} AND ${keyColumn} <> -1`,
      );
    } else if (key.dimension.businessKey) {
      joins.push(
        `  LEFT JOIN ${target} AS ${quoteIdentifier(alias)} ON ${quoteIdentifier(alias)}.${quoteIdentifier(key.dimension.businessKey.name)} = [s].${quoteIdentifier(valueAlias(key.dimension.businessKey.source))} AND ${keyColumn} <> -1`,
      );
    } else {
      joins.push(`  LEFT JOIN ${target} AS ${quoteIdentifier(alias)} ON 1 = 0`);
    }
    return `ISNULL(${keyColumn}, -1)`;
  });
  const values = [
    ...foreignValues,
    ...context.degenerates.map(
      (column) => `[s].${quoteIdentifier(valueAlias(column.source))}`,
    ),
    ...context.measures.map(
      (column) => `[s].${quoteIdentifier(valueAlias(column.source))}`,
    ),
  ];
  const measureComments = context.measures
    .map(
      (measure) =>
        `  -- ${commentText(measure.name)}: ${measure.model.aggregation} (${measure.model.additivity}); stored at source-row grain.`,
    )
    .join("\n");
  const insert = `${measureComments}\n  INSERT INTO ${fact} (${factColumns.map(quoteIdentifier).join(", ")})\n  SELECT ${values.join(", ")}\n  FROM [#DF_Candidates] AS [s]\n${joins.join("\n")}\n  WHERE [s].[__df_reject_reason] = N'';\n  SET @RowsOut = @@ROWCOUNT;\n\n  DROP TABLE [#DF_Candidates];\n  DROP TABLE [#DF_Source];`;
  const body = [
    `  -- Grain: ${commentText(context.input.model.fact.grain)}`,
    create,
    ...constraints,
    mode,
    watermark,
    "  DROP TABLE IF EXISTS [#DF_Candidates];\n  DROP TABLE IF EXISTS [#DF_Source];",
    source,
    candidates,
    eligible,
    reject,
    insert,
  ].join("\n\n");
  return {
    name: "04_fact.sql",
    description:
      "Converts staged values, records rejected rows, and loads the fact with dimension keys. Applies your duplicate and incremental options while preserving the saved grain.",
    sql: wrapStep(context, "04_fact", body),
  };
}
