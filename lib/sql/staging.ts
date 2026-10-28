import type { GeneratedFile, SqlContext } from "./types";
import {
  qualified,
  quoteIdentifier,
  sqlLiteral,
  textSqlType,
  wrapStep,
} from "./helpers";

export function stagingFile(context: SqlContext): GeneratedFile {
  const stage = qualified("stg", context.stageTable);
  const importView = qualified("stg", context.stageImportView);
  const rawColumns = context.input.columns.map((column) =>
    quoteIdentifier(context.stageColumns.get(String(column.ordinal))!),
  );
  const definitions = context.input.columns.map(
    (column) =>
      `      ${quoteIdentifier(context.stageColumns.get(String(column.ordinal))!)} ${textSqlType(column.maxLength)} COLLATE Latin1_General_100_BIN2 NULL`,
  );
  const viewSql = `CREATE OR ALTER VIEW ${importView} AS SELECT ${rawColumns.join(", ")} FROM ${stage};`;
  const bulkPrefix = `BULK INSERT ${importView} FROM '`;
  const bulkSuffix = `' WITH (FORMAT = 'CSV', FIRSTROW = 2, CODEPAGE = '65001', FIELDTERMINATOR = ',', FIELDQUOTE = '"', ROWTERMINATOR = '0x0a', TABLOCK);`;
  const filePath = context.input.options.filePath;
  if (
    filePath &&
    (filePath.length > 4000 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(filePath))
  )
    throw new Error(
      "The staging file path contains unsupported characters or exceeds 4,000 characters.",
    );
  const body = `  IF OBJECT_ID(${sqlLiteral(stage)}, N'U') IS NULL
    CREATE TABLE ${stage} (
${definitions.join(",\n")},
      [source_row_number] INT IDENTITY(2,1) NOT NULL
    );
  -- The import view exposes only CSV fields; the base table generates logical row numbers.
  EXEC [sys].[sp_executesql] ${sqlLiteral(viewSql)};
  TRUNCATE TABLE ${stage};
  -- REQUIRED: replace @FilePath with the server-accessible path to DataForge's Cleaned CSV.
  -- Download Cleaned CSV even for XLSX, BOM, semicolon, or tab-delimited source files.
  -- SQL Server's service account needs read access to this file; the browser's path is not sufficient.
  DECLARE @FilePath NVARCHAR(4000) = ${filePath ? sqlLiteral(filePath) : "N'C:\\DataForge\\REPLACE_WITH_CLEANED_SOURCE.csv'"};
  DECLARE @BulkSql NVARCHAR(MAX) = ${sqlLiteral(bulkPrefix)}
    + REPLACE(@FilePath, N'''', N'''''') + ${sqlLiteral(bulkSuffix)};
  EXEC [sys].[sp_executesql] @BulkSql;
  SET @RowsIn = (SELECT COUNT_BIG(*) FROM ${stage});
  SET @RowsOut = @RowsIn;`;
  return {
    name: "01_staging.sql",
    description:
      "Loads the cleaned UTF-8 CSV as raw text, keeping conversion errors out of staging. Set @FilePath to a SQL Server-accessible file before running.",
    sql: wrapStep(context, "01_staging", body),
  };
}
