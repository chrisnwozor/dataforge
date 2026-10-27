import type { GeneratedFile, SqlContext } from "./types";
import {
  converted,
  qualified,
  quoteIdentifier,
  sqlLiteral,
  wrapStep,
} from "./helpers";

export function dateFile(context: SqlContext): GeneratedFile {
  const calendars = context.dimensions.filter(
    (dimension) => dimension.model.generated === "date",
  );
  const stage = qualified("stg", context.stageTable);
  const parts: string[] = [];
  if (!calendars.length || !context.dateColumns.length) {
    parts.push(
      "  -- No calendar dimension is present in the saved model; this step has no date rows to load.",
    );
  } else {
    calendars.forEach((dimension, index) => {
      const table = qualified("dw", dimension.table);
      const key = quoteIdentifier(dimension.key);
      const dateSources = dimension.model.columnIds
        .map((id) => context.columns.get(id))
        .filter(
          (column) =>
            column && (column.overrideType ?? column.inferredType) === "date",
        );
      const values = dateSources.length ? dateSources : context.dateColumns;
      parts.push(`  IF OBJECT_ID(${sqlLiteral(table)}, N'U') IS NULL
    CREATE TABLE ${table} (
      ${key} INT NOT NULL PRIMARY KEY,
      [Date] DATE NULL,
      [Year] INT NOT NULL, [Quarter] INT NOT NULL, [QuarterName] NVARCHAR(10) NOT NULL,
      [Month] INT NOT NULL, [MonthName] NVARCHAR(20) NOT NULL,
      [Day] INT NOT NULL, [DayOfWeek] INT NOT NULL, [DayName] NVARCHAR(20) NOT NULL,
      [WeekOfYear] INT NOT NULL, [IsWeekend] BIT NOT NULL
    );
  IF NOT EXISTS (SELECT 1 FROM ${table} WHERE ${key} = -1)
    INSERT INTO ${table} (${key}, [Date], [Year], [Quarter], [QuarterName], [Month], [MonthName], [Day], [DayOfWeek], [DayName], [WeekOfYear], [IsWeekend])
    VALUES (-1, NULL, -1, -1, N'Unknown', -1, N'Unknown', -1, -1, N'Unknown', -1, 0);
  DECLARE @MinDate${index} DATE, @MaxDate${index} DATE, @StartDate${index} DATE, @EndDate${index} DATE;
  SELECT @MinDate${index} = MIN([v].[SourceDate]), @MaxDate${index} = MAX([v].[SourceDate])
  FROM ${stage} AS [s]
  CROSS APPLY (VALUES ${values.map((column) => `(${converted(context, column!)})`).join(", ")}) AS [v] ([SourceDate]);
  IF @MinDate${index} IS NOT NULL AND @MaxDate${index} IS NOT NULL
  BEGIN
    SET @StartDate${index} = CASE WHEN YEAR(@MinDate${index}) = 1 THEN CONVERT(DATE, N'00010101', 112) ELSE DATEADD(YEAR, -1, @MinDate${index}) END;
    SET @EndDate${index} = CASE WHEN YEAR(@MaxDate${index}) = 9999 THEN CONVERT(DATE, N'99991231', 112) ELSE DATEADD(YEAR, 1, @MaxDate${index}) END;
    ;WITH [Digits] AS (
      SELECT [n] FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) AS [d] ([n])
    ), [Numbers] AS (
      SELECT TOP (DATEDIFF(DAY, @StartDate${index}, @EndDate${index}) + 1)
        ROW_NUMBER() OVER (ORDER BY [a].[n], [b].[n], [c].[n], [d].[n], [e].[n], [f].[n], [g].[n]) - 1 AS [n]
      FROM [Digits] AS [a] CROSS JOIN [Digits] AS [b] CROSS JOIN [Digits] AS [c]
      CROSS JOIN [Digits] AS [d] CROSS JOIN [Digits] AS [e] CROSS JOIN [Digits] AS [f] CROSS JOIN [Digits] AS [g]
    ), [Dates] AS (
      SELECT DATEADD(DAY, CAST([n] AS INT), @StartDate${index}) AS [CalendarDate] FROM [Numbers]
    ), [Calendar] AS (
      SELECT [CalendarDate], ((DATEDIFF(DAY, CONVERT(DATE, N'19000101', 112), [CalendarDate]) % 7 + 7) % 7) + 1 AS [IsoWeekday]
      FROM [Dates]
    )
    INSERT INTO ${table} (${key}, [Date], [Year], [Quarter], [QuarterName], [Month], [MonthName], [Day], [DayOfWeek], [DayName], [WeekOfYear], [IsWeekend])
    SELECT YEAR([c].[CalendarDate]) * 10000 + MONTH([c].[CalendarDate]) * 100 + DAY([c].[CalendarDate]),
      [c].[CalendarDate], YEAR([c].[CalendarDate]), DATEPART(QUARTER, [c].[CalendarDate]),
      N'Q' + CONVERT(NVARCHAR(1), DATEPART(QUARTER, [c].[CalendarDate])), MONTH([c].[CalendarDate]),
      CASE MONTH([c].[CalendarDate]) WHEN 1 THEN N'January' WHEN 2 THEN N'February' WHEN 3 THEN N'March' WHEN 4 THEN N'April' WHEN 5 THEN N'May' WHEN 6 THEN N'June' WHEN 7 THEN N'July' WHEN 8 THEN N'August' WHEN 9 THEN N'September' WHEN 10 THEN N'October' WHEN 11 THEN N'November' ELSE N'December' END,
      DAY([c].[CalendarDate]), [c].[IsoWeekday],
      CASE [c].[IsoWeekday] WHEN 1 THEN N'Monday' WHEN 2 THEN N'Tuesday' WHEN 3 THEN N'Wednesday' WHEN 4 THEN N'Thursday' WHEN 5 THEN N'Friday' WHEN 6 THEN N'Saturday' ELSE N'Sunday' END,
      DATEPART(ISO_WEEK, [c].[CalendarDate]), CAST(CASE WHEN [c].[IsoWeekday] IN (6, 7) THEN 1 ELSE 0 END AS BIT)
    FROM [Calendar] AS [c]
    WHERE NOT EXISTS (SELECT 1 FROM ${table} AS [existing] WHERE [existing].${key} = YEAR([c].[CalendarDate]) * 10000 + MONTH([c].[CalendarDate]) * 100 + DAY([c].[CalendarDate]));
    SET @RowsOut = @RowsOut + @@ROWCOUNT;
  END;`);
    });
    parts.push(`  SET @RowsIn = (SELECT COUNT_BIG(*) FROM ${stage});`);
  }
  return {
    name: "02_dim_date.sql",
    description: calendars.length
      ? "Builds the saved calendar dimension from source dates with a one-year buffer. Adds an Unknown member and stable English calendar labels."
      : "No saved calendar dimension needs to be generated for this model. Records the skipped calendar step in the run log.",
    sql: wrapStep(context, "02_dim_date", parts.join("\n")),
  };
}
