/*
DataForge query timing comparison — SQL Server 2019+

Run in SSMS against the same database/login used by DataForge. This file does
not change warehouse data. It contains a runnable Superstore baseline followed
by a place to paste the exact SQL from Generated SQL in the Measures tab.

1. Enable Include Actual Execution Plan (Ctrl+M).
2. Run the baseline once to warm the SQL plan/data caches, then run it again.
3. Copy the app's generated SQL and parameter values into the second section.
   Keep parameter types equal to the driver's bindings: __df_limit is INT;
   integral filter values are BIGINT, other numeric values FLOAT, booleans BIT,
   dates DATETIME2, and text NVARCHAR(MAX). Do not interpolate values into SQL.
4. Compare Messages' SQL CPU/elapsed time and logical reads with the app's
   Timing phases. SSMS excludes HTTP/Node parsing/compilation/pool acquisition.
   sendToFirstRowMs includes server work and network round trips; fetchMs is
   the remaining rows/DONE response, not SQL CPU time by itself.

Use the exact physical table/column names shown by the semantic model if the
saved model has been renamed. The defaults below match superstore_sales.csv.
Never clear the server plan/buffer cache on a shared server for this test.
*/

SET NOCOUNT ON;
SET STATISTICS TIME ON;
SET STATISTICS IO ON;

-- Runnable comparison: base aggregates are computed once; ratios use columns.
-- Remove output columns cumulatively to compare Sales; + Profit Margin %;
-- + Avg Order Value; + Sales % of Total; + Furniture Sales.
DECLARE @__df_limit INT = 1001;

;WITH [category_aggregates] AS (
    SELECT [p].[category] AS [Category],
        SUM(CAST([f].[sales] AS DECIMAL(38, 10))) AS [Sales],
        SUM(CAST([f].[profit] AS DECIMAL(38, 10))) AS [Profit],
        COUNT_BIG(DISTINCT [f].[order_id]) AS [Orders]
    FROM [dw].[fact_sales] AS [f]
    LEFT JOIN [dw].[dim_product] AS [p]
        ON [f].[product_key] = [p].[product_key]
    WHERE [f].[product_key] <> -1
    GROUP BY [p].[category]
), [totals] AS (
    SELECT [Category], [Sales], [Profit], [Orders],
        SUM([Sales]) OVER () AS [All Sales],
        SUM(CASE WHEN [Category] = N'Furniture' THEN [Sales] END) OVER ()
            AS [Furniture Sales]
    FROM [category_aggregates]
)
SELECT TOP (@__df_limit) [Category], [Sales],
    CAST([Profit] AS FLOAT) / NULLIF([Sales], 0) AS [Profit Margin %],
    CAST([Sales] AS FLOAT) / NULLIF([Orders], 0) AS [Avg Order Value],
    CAST([Sales] AS FLOAT) / NULLIF([All Sales], 0) AS [Sales % of Total],
    [Furniture Sales]
FROM [totals]
ORDER BY [Category];
GO

-- Exact reported Product + Category comparison. Both denominators come from
-- the same grouped fact read, with independent category/grand-total windows.
DECLARE @__df_limit INT = 1001;
;WITH [product_aggregates] AS (
    SELECT [p].[product] AS [Product], [p].[category] AS [Category],
        SUM(CAST([f].[sales] AS DECIMAL(38, 10))) AS [Sales]
    FROM [dw].[fact_sales] AS [f]
    LEFT JOIN [dw].[dim_product] AS [p]
        ON [f].[product_key] = [p].[product_key]
    WHERE [f].[product_key] <> -1
    GROUP BY [p].[product], [p].[category]
), [denominators] AS (
    SELECT [Product], [Category], [Sales],
        SUM([Sales]) OVER (PARTITION BY [Category]) AS [Category Sales],
        SUM([Sales]) OVER () AS [Grand Sales]
    FROM [product_aggregates]
)
SELECT TOP (@__df_limit) [Product], [Category], [Sales],
    CAST([Sales] AS FLOAT) / NULLIF([Category Sales], 0) AS [Sales % of Category],
    CAST([Sales] AS FLOAT) / NULLIF([Grand Sales], 0) AS [Sales % of Grand Total]
FROM [denominators]
ORDER BY [Product], [Category];
GO

/*
Exact generated-query comparison:

DECLARE @__df_limit INT = 1001;
DECLARE @p0 NVARCHAR(MAX) = N'Furniture'; -- replace/add from the preview params

-- Paste the complete generated WITH ... SELECT here, unchanged.

The actual plan should access dw.fact_sales once for the Sales/ratio cases.
Inspect Table/Index/Columnstore Scan or Seek operators, their Actual Number of
Executions, rebinds/rewinds, spills and warnings. A single textual FROM clause
does not prove one physical scan: SQL Server can inline a multiply-used CTE.

If SQL elapsed time is low but the app is slow, compare compileMs, poolAcquireMs
and connectMs first. A warm reused connection normally has connectMs = 0.
If both SSMS and sendToFirstRowMs are slow, inspect blocking, reads, estimates,
and any CONVERT_IMPLICIT on filter/join columns. Match parameter types instead
of casting indexed columns unnecessarily.

To investigate parameter-sensitive plans, execute the same parameterized query
with representative filter values and compare actual/estimated row counts and
plans. A diagnostic rerun with OPTION (RECOMPILE) can help establish causality;
it is not enabled by DataForge automatically. Keep it only if measurements show
that compilation cost and plan quality improve the workload.
*/

SET STATISTICS IO OFF;
SET STATISTICS TIME OFF;
