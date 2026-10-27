import type { SqlColumn, SqlContext } from "./types";

/** SQL Server brackets escape a closing bracket by doubling it. */
export function quoteIdentifier(name: string): string {
  return `[${name.replaceAll("]", "]]")}]`;
}

/** SQL Server Unicode string literals escape an apostrophe by doubling it. */
export function sqlLiteral(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

/** SQL identifiers use UTF-16 lengths; never leave half a supplementary character. */
function identifierPrefix(value: string, maxLength: number): string {
  const prefix = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

export function sanitizeIdentifier(value: string, fallback = "column"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = normalized || fallback;
  return identifierPrefix(/^[\p{L}_]/u.test(name) ? name : `c_${name}`, 128);
}

export function uniqueIdentifier(candidate: string, used: Set<string>): string {
  const base = sanitizeIdentifier(candidate);
  let name = base;
  let suffix = 2;
  while (used.has(name.toLocaleLowerCase("en-US"))) {
    const ending = `_${suffix++}`;
    name = `${identifierPrefix(base, 128 - ending.length)}${ending}`;
  }
  used.add(name.toLocaleLowerCase("en-US"));
  return name;
}

export function textSqlType(maxLength: number): string {
  const length = Math.max(50, Math.ceil(Math.max(0, maxLength) * 1.25));
  return length > 4_000 ? "NVARCHAR(MAX)" : `NVARCHAR(${length})`;
}

export function sqlType(column: SqlColumn): string {
  const type = column.overrideType ?? column.inferredType;
  if (type === "integer") {
    // Bounds from a different inferred type may be lexical, not numeric bounds.
    if (column.inferredType !== "integer") return "BIGINT";
    try {
      if (
        (column.maxValue !== null &&
          BigInt(column.maxValue.replaceAll(",", "")) > BigInt("2147483647")) ||
        (column.minValue !== null &&
          BigInt(column.minValue.replaceAll(",", "")) < BigInt("-2147483648"))
      )
        return "BIGINT";
    } catch {
      /* An overridden type's bounds may still describe source text. */
    }
    return "INT";
  }
  if (type === "decimal")
    return `DECIMAL(18, ${Math.max(2, Math.min(6, column.maxDecimalPlaces))})`;
  if (type === "date") return "DATE";
  if (type === "boolean") return "BIT";
  return textSqlType(column.maxLength);
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function sourceRaw(
  context: SqlContext,
  id: string,
  alias = "s",
): string {
  const name = context.stageColumns.get(id);
  if (!name) throw new Error(`Unknown source column ${id}.`);
  return `NULLIF(TRIM(@TrimCharacters FROM ${quoteIdentifier(alias)}.${quoteIdentifier(name)}), N'')`;
}

export function converted(
  context: SqlContext,
  column: SqlColumn,
  alias = "s",
): string {
  const raw = sourceRaw(context, String(column.ordinal), alias);
  const type = column.overrideType ?? column.inferredType;
  if (type === "text") return raw;
  if (type === "date")
    return `COALESCE(TRY_CONVERT(DATE, ${raw}, 23), TRY_CONVERT(DATE, ${raw}, 126), TRY_CONVERT(DATE, ${raw}, 101))`;
  if (type === "boolean")
    return `CASE LOWER(${raw}) WHEN N'true' THEN CAST(1 AS BIT) WHEN N'yes' THEN CAST(1 AS BIT) WHEN N'1' THEN CAST(1 AS BIT) WHEN N'false' THEN CAST(0 AS BIT) WHEN N'no' THEN CAST(0 AS BIT) WHEN N'0' THEN CAST(0 AS BIT) ELSE NULL END`;
  return `TRY_CONVERT(${sqlType(column)}, [etl].[normalize_number](${raw}))`;
}

/** User text is flattened before inclusion in a single-line SQL comment. */
export function commentText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ");
}

export function header(context: SqlContext, title: string): string {
  return `-- DataForge: ${commentText(title)}\n-- Project: ${commentText(context.input.project.name)}\n-- Generated: ${commentText(context.input.options.generatedAt)}\n-- Source file: ${commentText(context.input.project.sourceFile)}\n-- Review before running. SQL Server 2019+. No script is executed by DataForge.\nUSE ${quoteIdentifier(context.input.options.database)};\nGO\nSET NOCOUNT ON;\nSET XACT_ABORT ON;\nSET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;\n`;
}

/** Every step shares a run ID through the current SSMS/Azure Data Studio session. */
export function wrapStep(
  context: SqlContext,
  step: string,
  body: string,
  counts: {
    rowsIn?: string;
    rowsOut?: string;
    rowsRejected?: string;
    cleanup?: string;
  } = {},
  newRun = false,
): string {
  const key = sqlLiteral(`DataForgeRunId:${context.input.project.id}`);
  const initialize = newRun
    ? "NEWID()"
    : `TRY_CONVERT(UNIQUEIDENTIFIER, SESSION_CONTEXT(${key}))`;
  const stepLiteral = sqlLiteral(step);
  const whitespace = [
    9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198,
    8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279,
  ]
    .map((code) => `NCHAR(${code})`)
    .join(" + ");
  return `${header(context, step)}\nDECLARE @RunId UNIQUEIDENTIFIER = ${initialize};\nIF @RunId IS NULL SET @RunId = NEWID();\nEXEC [sys].[sp_set_session_context] @key = ${key}, @value = @RunId;\nDECLARE @StartedAt DATETIME2(3) = SYSUTCDATETIME();\nDECLARE @RowsIn BIGINT = 0, @RowsOut BIGINT = 0, @RowsRejected BIGINT = 0;\nDECLARE @TrimCharacters NVARCHAR(100) = ${whitespace};\nBEGIN TRY\n  BEGIN TRANSACTION;\n${body}\n${counts.rowsIn ? `  SET @RowsIn = ${counts.rowsIn};\n` : ""}${counts.rowsOut ? `  SET @RowsOut = ${counts.rowsOut};\n` : ""}${counts.rowsRejected ? `  SET @RowsRejected = ${counts.rowsRejected};\n` : ""}  INSERT INTO [etl].[run_log] ([run_id], [step], [started_at], [finished_at], [rows_in], [rows_out], [rows_rejected], [status], [message])\n  VALUES (@RunId, ${stepLiteral}, @StartedAt, SYSUTCDATETIME(), @RowsIn, @RowsOut, @RowsRejected, N'Succeeded', N'Completed.');\n  COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\n${counts.cleanup ? `${counts.cleanup}\n` : ""}  IF OBJECT_ID(N'[etl].[run_log]', N'U') IS NOT NULL\n    INSERT INTO [etl].[run_log] ([run_id], [step], [started_at], [finished_at], [rows_in], [rows_out], [rows_rejected], [status], [message])\n    VALUES (@RunId, ${stepLiteral}, @StartedAt, SYSUTCDATETIME(), @RowsIn, @RowsOut, @RowsRejected, N'Failed', ERROR_MESSAGE());\n  THROW;\nEND CATCH;\n`;
}
