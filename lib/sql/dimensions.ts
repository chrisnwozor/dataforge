import type { GeneratedFile, SqlContext } from "./types";
import {
  converted,
  qualified,
  quoteIdentifier,
  sqlLiteral,
  wrapStep,
} from "./helpers";

export function dimensionFile(context: SqlContext): GeneratedFile {
  const dimensions = context.dimensions.filter(
    (dimension) => dimension.model.generated !== "date",
  );
  const stage = qualified("stg", context.stageTable);
  const parts = ["  DECLARE @IdentityTable NVARCHAR(300) = NULL;"];
  for (const dimension of dimensions) {
    const table = qualified("dw", dimension.table);
    const key = quoteIdentifier(dimension.key);
    const businessKey = dimension.businessKey;
    if (!businessKey)
      throw new Error(
        `Dimension ${dimension.model.name} needs a business key.`,
      );
    const attributes = dimension.columns.filter(
      (column) => column.id !== businessKey.id,
    );
    const definitions = dimension.columns.map(
      (column) =>
        `      ${quoteIdentifier(column.name)} ${column.type}${(column.source.overrideType ?? column.source.inferredType) === "text" ? " COLLATE Latin1_General_100_BIN2" : ""} NULL`,
    );
    const columns = dimension.columns.map((column) =>
      quoteIdentifier(column.name),
    );
    const unknownValues = dimension.columns.map((column) =>
      column.id === businessKey.id ||
      (column.source.overrideType ?? column.source.inferredType) !== "text"
        ? "NULL"
        : "N'Unknown'",
    );
    const selected = dimension.columns.map(
      (column) =>
        `      ${converted(context, column.source)} AS ${quoteIdentifier(column.name)}`,
    );
    const order = attributes.length
      ? attributes
          .map(
            (column) =>
              `CASE WHEN ${converted(context, column.source)} IS NULL THEN 0 ELSE 1 END`,
          )
          .join(" + ")
      : "";
    const value = (column: typeof businessKey) =>
      (column.source.overrideType ?? column.source.inferredType) === "text" &&
      column.id !== businessKey.id
        ? `COALESCE([r].${quoteIdentifier(column.name)}, N'Unknown')`
        : `[r].${quoteIdentifier(column.name)}`;
    const sourceColumns = dimension.columns
      .map((column) => `${value(column)} AS ${quoteIdentifier(column.name)}`)
      .join(", ");
    const changes = attributes
      .map((column) => `[source].${quoteIdentifier(column.name)}`)
      .join(", ");
    const targetChanges = attributes
      .map((column) => `[target].${quoteIdentifier(column.name)}`)
      .join(", ");
    parts.push(`  IF OBJECT_ID(${sqlLiteral(table)}, N'U') IS NULL
    CREATE TABLE ${table} (
      ${key} INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
${definitions.join(",\n")},
      [created_at] DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
      [updated_at] DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME()
    );
  IF NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key} = -1)
  BEGIN
    SET IDENTITY_INSERT ${table} ON;
    SET @IdentityTable = ${sqlLiteral(table)};
    INSERT INTO ${table} (${key}, ${columns.join(", ")}, [created_at], [updated_at])
    VALUES (-1, ${unknownValues.join(", ")}, SYSUTCDATETIME(), SYSUTCDATETIME());
    SET IDENTITY_INSERT ${table} OFF;
    SET @IdentityTable = NULL;
  END;
  -- Rank before replacing null text attributes so a populated attribute wins over a blank.
  ;WITH [Ranked] AS (
    SELECT
${selected.join(",\n")},
      ROW_NUMBER() OVER (
        PARTITION BY ${converted(context, businessKey.source)}
        ORDER BY ${order ? `(${order}) DESC, ` : ""}[s].[source_row_number] ASC
      ) AS [__df_dimension_rank]
    FROM ${stage} AS [s]
    WHERE ${converted(context, businessKey.source)} IS NOT NULL
  )
  MERGE ${table} WITH (HOLDLOCK) AS [target]
  USING (SELECT ${sourceColumns} FROM [Ranked] AS [r] WHERE [r].[__df_dimension_rank] = 1) AS [source]
  ON [target].${quoteIdentifier(businessKey.name)} = [source].${quoteIdentifier(businessKey.name)}
${
  attributes.length
    ? `  WHEN MATCHED AND EXISTS (SELECT ${changes} EXCEPT SELECT ${targetChanges}) THEN
    UPDATE SET ${attributes.map((column) => `[target].${quoteIdentifier(column.name)} = [source].${quoteIdentifier(column.name)}`).join(", ")}, [target].[updated_at] = SYSUTCDATETIME()
`
    : ""
}  WHEN NOT MATCHED BY TARGET THEN
    INSERT (${columns.join(", ")}, [created_at], [updated_at])
    VALUES (${dimension.columns.map((column) => `[source].${quoteIdentifier(column.name)}`).join(", ")}, SYSUTCDATETIME(), SYSUTCDATETIME());
  SET @RowsOut = @RowsOut + @@ROWCOUNT;`);
  }
  if (!dimensions.length)
    parts.push("  -- The saved model has no descriptive dimensions to merge.");
  parts.push(`  SET @RowsIn = (SELECT COUNT_BIG(*) FROM ${stage});`);
  return {
    name: "03_dimensions.sql",
    description:
      "Creates descriptive dimensions, Unknown members, and audit columns. Merges one row per business key, preferring populated attributes over blanks.",
    sql: wrapStep(context, "03_dimensions", parts.join("\n"), {
      cleanup: `  IF @IdentityTable IS NOT NULL
  BEGIN
    BEGIN TRY
      EXEC(N'SET IDENTITY_INSERT ' + @IdentityTable + N' OFF;');
    END TRY
    BEGIN CATCH
      -- Preserve the original load error if the session setting cannot be reset.
    END CATCH;
  END;`,
    }),
  };
}
