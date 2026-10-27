import type { GeneratedFile, SqlContext } from "./types";
import { sqlLiteral, wrapStep } from "./helpers";

/** Expand exponent notation as text, avoiding an imprecise FLOAT intermediary. */
const normalizeNumberFunction = `CREATE OR ALTER FUNCTION [etl].[normalize_number] (@Value NVARCHAR(MAX))
RETURNS NVARCHAR(MAX)
AS
BEGIN
  DECLARE @Input NVARCHAR(MAX) = LTRIM(RTRIM(@Value));
  DECLARE @InputE INT = CHARINDEX(N'e', LOWER(@Input));
  DECLARE @GroupedMantissa NVARCHAR(MAX) = CASE WHEN @InputE = 0 THEN @Input ELSE LEFT(@Input, @InputE - 1) END;
  IF @InputE > 0 AND CHARINDEX(N',', SUBSTRING(@Input, @InputE + 1, LEN(@Input))) > 0 RETURN NULL;
  IF CHARINDEX(N',', @GroupedMantissa) > 0
  BEGIN
    IF LEFT(@GroupedMantissa, 1) IN (N'-', N'+') SET @GroupedMantissa = SUBSTRING(@GroupedMantissa, 2, LEN(@GroupedMantissa));
    DECLARE @GroupedDot INT = CHARINDEX(N'.', @GroupedMantissa);
    DECLARE @IntegerPart NVARCHAR(MAX) = CASE WHEN @GroupedDot = 0 THEN @GroupedMantissa ELSE LEFT(@GroupedMantissa, @GroupedDot - 1) END;
    IF @GroupedDot > 0 AND CHARINDEX(N',', SUBSTRING(@GroupedMantissa, @GroupedDot + 1, LEN(@GroupedMantissa))) > 0 RETURN NULL;
    DECLARE @Comma INT = CHARINDEX(N',', @IntegerPart);
    IF @Comma < 2 OR @Comma > 4 OR LEFT(@IntegerPart, @Comma - 1) COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%' RETURN NULL;
    WHILE @Comma > 0
    BEGIN
      DECLARE @NextComma INT = CHARINDEX(N',', @IntegerPart, @Comma + 1);
      DECLARE @Group NVARCHAR(MAX) = SUBSTRING(@IntegerPart, @Comma + 1, CASE WHEN @NextComma = 0 THEN LEN(@IntegerPart) ELSE @NextComma - 1 END - @Comma);
      IF LEN(@Group) <> 3 OR @Group COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%' RETURN NULL;
      SET @Comma = @NextComma;
    END;
  END;
  DECLARE @Text NVARCHAR(MAX) = REPLACE(@Input, N',', N'');
  DECLARE @E INT = CHARINDEX(N'e', LOWER(@Text));
  IF @E = 0 OR @Text IS NULL RETURN @Text;
  IF CHARINDEX(N'e', LOWER(@Text), @E + 1) > 0 RETURN NULL;
  DECLARE @Mantissa NVARCHAR(MAX) = LEFT(@Text, @E - 1);
  DECLARE @ExponentText NVARCHAR(MAX) = SUBSTRING(@Text, @E + 1, LEN(@Text));
  DECLARE @Negative BIT = CASE WHEN LEFT(@Mantissa, 1) = N'-' THEN 1 ELSE 0 END;
  IF LEFT(@Mantissa, 1) IN (N'-', N'+') SET @Mantissa = SUBSTRING(@Mantissa, 2, LEN(@Mantissa));
  IF LEFT(@ExponentText, 1) IN (N'-', N'+')
    BEGIN
      IF SUBSTRING(@ExponentText, 2, LEN(@ExponentText)) COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%' OR LEN(@ExponentText) < 2 RETURN NULL;
    END
  ELSE IF @ExponentText COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%' OR LEN(@ExponentText) = 0 RETURN NULL;
  DECLARE @Exponent INT = TRY_CONVERT(INT, @ExponentText);
  IF @Exponent IS NULL OR LEN(@Mantissa) = 0 OR @Mantissa COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9.]%' RETURN NULL;
  IF LEN(@Mantissa) - LEN(REPLACE(@Mantissa, N'.', N'')) > 1 RETURN NULL;
  DECLARE @Dot INT = CHARINDEX(N'.', @Mantissa);
  DECLARE @Digits NVARCHAR(MAX) = REPLACE(@Mantissa, N'.', N'');
  IF LEN(@Digits) = 0 RETURN NULL;
  IF @Digits COLLATE Latin1_General_100_BIN2 NOT LIKE N'%[1-9]%' RETURN N'0';
  DECLARE @Position BIGINT = CAST(CASE WHEN @Dot = 0 THEN LEN(@Mantissa) ELSE @Dot - 1 END AS BIGINT) + @Exponent;
  -- Values below 0.0000001 round to zero for every generated scale (at most six).
  IF @Position < -6 RETURN N'0';
  -- Non-zero values needing more than 38 trailing zeroes cannot fit DECIMAL(18,s) or BIGINT.
  IF @Position > CAST(LEN(@Digits) AS BIGINT) + 38 RETURN NULL;
  DECLARE @Result NVARCHAR(MAX);
  IF @Position <= 0 SET @Result = N'0.' + REPLICATE(CAST(N'0' AS NVARCHAR(MAX)), CAST(-@Position AS INT)) + @Digits;
  ELSE IF @Position >= LEN(@Digits) SET @Result = @Digits + REPLICATE(CAST(N'0' AS NVARCHAR(MAX)), CAST(@Position - LEN(@Digits) AS INT));
  ELSE SET @Result = STUFF(@Digits, CAST(@Position + 1 AS INT), 0, N'.');
  RETURN CASE WHEN @Negative = 1 THEN N'-' ELSE N'' END + @Result;
END`;

export function setupFile(context: SqlContext): GeneratedFile {
  const body = `  IF SCHEMA_ID(N'stg') IS NULL EXEC(N'CREATE SCHEMA [stg]');
  IF SCHEMA_ID(N'dw') IS NULL EXEC(N'CREATE SCHEMA [dw]');
  IF SCHEMA_ID(N'etl') IS NULL EXEC(N'CREATE SCHEMA [etl]');
  IF OBJECT_ID(N'[etl].[run_log]', N'U') IS NULL
    CREATE TABLE [etl].[run_log] (
      [run_id] UNIQUEIDENTIFIER NOT NULL,
      [step] NVARCHAR(128) NOT NULL,
      [started_at] DATETIME2(3) NOT NULL,
      [finished_at] DATETIME2(3) NULL,
      [rows_in] BIGINT NOT NULL DEFAULT (0),
      [rows_out] BIGINT NOT NULL DEFAULT (0),
      [rows_rejected] BIGINT NOT NULL DEFAULT (0),
      [status] NVARCHAR(30) NOT NULL,
      [message] NVARCHAR(MAX) NULL
    );
  IF OBJECT_ID(N'[dw].[reject_rows]', N'U') IS NULL
    CREATE TABLE [dw].[reject_rows] (
      [run_id] UNIQUEIDENTIFIER NOT NULL,
      [source_row_number] INT NOT NULL,
      [reason] NVARCHAR(MAX) NOT NULL,
      [raw_json] NVARCHAR(MAX) NOT NULL
    );
  -- Exact decimal-text normalization supports grouped and scientific numeric input.
  EXEC [sys].[sp_executesql] ${sqlLiteral(normalizeNumberFunction)};`;
  return {
    name: "00_setup.sql",
    description:
      "Creates staging, warehouse, and logging schemas, plus reject storage. Starts a shared run ID and installs exact numeric text normalization.",
    sql: wrapStep(context, "00_setup", body, {}, true),
  };
}
