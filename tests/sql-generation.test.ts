import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Parser } from "node-sql-parser";
import { profileFile } from "@/lib/profiler";
import { suggestModel } from "@/lib/modeling/suggest";
import { generateSql, buildSqlContext } from "@/lib/sql";
import {
  quoteIdentifier,
  sanitizeIdentifier,
  uniqueIdentifier,
  sqlLiteral,
  textSqlType,
  sqlType,
} from "@/lib/sql/helpers";
import type { SqlColumn, SqlGenerationInput } from "@/lib/sql/types";

let sales: SqlGenerationInput;
beforeAll(async () => {
  sales = await sampleInput("superstore_sales.csv");
});

async function sampleInput(filename: string): Promise<SqlGenerationInput> {
  const profile = await profileFile(
    join(process.cwd(), "samples", filename),
    "CSV",
  );
  const model = suggestModel({
    columns: profile.columns.map((column) => ({
      id: String(column.ordinal),
      ordinal: column.ordinal,
      name: column.name,
      type: column.inferredType,
      distinctCount: column.distinctCount,
      nullPct: column.nullPct,
      isKeyCandidate: column.isKeyCandidate,
      isNearKeyCandidate: column.isNearKeyCandidate,
    })),
    sampledRows: profile.sampledRows,
    rowCount: profile.rowCount,
    duplicateRowCount: profile.duplicateRowCount,
    topic: filename,
  });
  return {
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Superstore sales",
      sourceFile: filename,
      sourceType: "CSV",
    },
    columns: profile.columns.map((column) => ({
      ...column,
      overrideType: null,
      maxLength: column.maxLength ?? 50,
      maxDecimalPlaces: column.maxDecimalPlaces ?? 2,
    })),
    model,
    options: {
      incremental: false,
      dedupe: false,
      database: "DataForge",
      generatedAt: "2026-10-27T12:00:00.000Z",
    },
  };
}

function sql(input: SqlGenerationInput, filename: string): string {
  return generateSql(input).find((file) => file.name === filename)!.sql;
}

describe("SQL identifier and literal safety", () => {
  it.each([
    ["name]with]brackets", "[name]]with]]brackets]"],
    ["O'Brien", "[O'Brien]"],
    ["Order ID", "[Order ID]"],
    ["select", "[select]"],
    ["客户 résumé", "[客户 résumé]"],
  ])("brackets %s without interpreting it", (input, expected) => {
    expect(quoteIdentifier(input)).toBe(expected);
  });
  it("escapes Unicode SQL literals and produces bounded collision-safe names", () => {
    expect(sqlLiteral("O'Brien's sales")).toBe("N'O''Brien''s sales'");
    const names = [
      "Order ID",
      "order_id",
      "ORDER ID",
      "select",
      "客户",
      "9 Amount",
      "]' ; --",
    ];
    const used = new Set<string>();
    const mapped = names.map((name) => uniqueIdentifier(name, used));
    expect(mapped.slice(0, 3)).toEqual([
      "order_id",
      "order_id_2",
      "order_id_3",
    ]);
    expect(new Set(mapped.map((name) => name.toLowerCase())).size).toBe(
      names.length,
    );
    for (const name of mapped)
      expect(name).toMatch(/^[\p{L}_][\p{L}\p{N}_]*$/u);
    expect(sanitizeIdentifier("Crème Brûlée")).toBe("creme_brulee");
    expect(uniqueIdentifier("x".repeat(200), used)).toHaveLength(128);
    expect(uniqueIdentifier("x".repeat(200), used)).toHaveLength(128);
  });
  it("keeps project comments and database identifiers from becoming SQL statements", () => {
    const input = structuredClone(sales);
    input.project.name = "Sales\nGO\nDROP TABLE users; --";
    input.project.sourceFile = "O'Brien\r\nDROP TABLE users.csv";
    input.options.database = "Warehouse]; DROP DATABASE master; --";
    for (const file of generateSql(input)) {
      expect(file.sql).toContain(
        "USE [Warehouse]]; DROP DATABASE master; --];",
      );
      expect(file.sql).toContain("-- Project: Sales GO DROP TABLE users; --");
      expect(file.sql).not.toMatch(/^DROP TABLE users/m);
      expect(file.sql).toContain("Review before running");
    }
  });
  it("does not split supplementary Unicode characters at identifier or collision-suffix limits", () => {
    const used = new Set<string>();
    const truncated = sanitizeIdentifier("a".repeat(127) + "𠮷");
    expect(truncated).toHaveLength(127);
    const name = "a".repeat(125) + "𠮷b";
    const first = uniqueIdentifier(name, used);
    const second = uniqueIdentifier(name, used);
    expect(first.isWellFormed()).toBe(true);
    expect(second.isWellFormed()).toBe(true);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second.length).toBeLessThanOrEqual(128);
    expect(second).not.toBe(first);
  });
});

describe("SQL Server profile type mapping", () => {
  function column(patch: Partial<SqlColumn> = {}): SqlColumn {
    return { ...sales.columns[7], ...patch };
  }
  it.each([
    ["integer", "2147483647", "-2147483648", "INT"],
    ["integer", "2147483648", "1", "BIGINT"],
    ["integer", "0", "-2147483649", "BIGINT"],
    ["date", null, null, "DATE"],
    ["boolean", null, null, "BIT"],
    ["text", null, null, "NVARCHAR(50)"],
  ] as const)(
    "maps %s bounds %s/%s to %s",
    (type, maxValue, minValue, expected) => {
      expect(
        sqlType(
          column({
            inferredType: type,
            overrideType: null,
            maxValue,
            minValue,
            maxLength: 20,
          }),
        ),
      ).toBe(expected);
    },
  );
  it("respects overrides, decimal precision limits, and complete raw UTF-16 lengths", () => {
    expect(
      sqlType(
        column({
          inferredType: "text",
          overrideType: "integer",
          maxValue: "3,000,000,000",
        }),
      ),
    ).toBe("BIGINT");
    expect(sqlType(column({ overrideType: "text", maxLength: 41 }))).toBe(
      "NVARCHAR(52)",
    );
    expect(sqlType(column({ maxDecimalPlaces: 0 }))).toBe("DECIMAL(18, 2)");
    expect(sqlType(column({ maxDecimalPlaces: 4 }))).toBe("DECIMAL(18, 4)");
    expect(sqlType(column({ maxDecimalPlaces: 12 }))).toBe("DECIMAL(18, 6)");
    expect(textSqlType(0)).toBe("NVARCHAR(50)");
    expect(textSqlType(3200)).toBe("NVARCHAR(4000)");
    expect(textSqlType(3201)).toBe("NVARCHAR(MAX)");
  });
});

describe("saved-model T-SQL generation", () => {
  it("snapshots the complete six-file real Superstore pipeline", () => {
    expect(generateSql(sales)).toMatchSnapshot();
  });
  it("uses the expected source, fact, four measures, and four dimension links", () => {
    const context = buildSqlContext(sales);
    expect(context.stageTable).toBe("superstore_sales");
    expect(context.factTable).toBe("fact_sales");
    expect(context.measures.map((measure) => measure.name)).toEqual([
      "sales",
      "quantity",
      "discount",
      "profit",
    ]);
    expect(context.foreignKeys).toHaveLength(4);
    expect(
      context.dimensions.map((dimension) => dimension.table).sort(),
    ).toEqual(["dim_customer", "dim_date", "dim_product", "dim_region"]);
    const files = generateSql(sales);
    expect(files.map((file) => file.name)).toEqual([
      "00_setup.sql",
      "01_staging.sql",
      "02_dim_date.sql",
      "03_dimensions.sql",
      "04_fact.sql",
      "05_checks.sql",
    ]);
    expect(
      files.every(
        (file) =>
          file.description.length > 0 &&
          file.sql.includes("BEGIN TRY") &&
          file.sql.includes("BEGIN TRANSACTION") &&
          file.sql.includes("[etl].[run_log]"),
      ),
    ).toBe(true);
    expect(sql(sales, "04_fact.sql").match(/FOREIGN KEY/g)).toHaveLength(4);
  });
  it("partitions every source column only when exact duplicate removal is enabled", () => {
    const input = structuredClone(sales);
    input.options.dedupe = true;
    const enabled = sql(input, "04_fact.sql");
    const disabled = sql(sales, "04_fact.sql");
    expect(enabled).toMatch(/ROW_NUMBER\(\) OVER\s*\(\s*PARTITION BY/);
    expect(disabled).not.toMatch(/ROW_NUMBER\(\) OVER\s*\(\s*PARTITION BY/);
    const partition =
      enabled.match(/PARTITION BY ([\s\S]*?)ORDER BY/)?.[1] ?? "";
    for (const name of buildSqlContext(input).stageColumns.values())
      expect(partition).toContain(quoteIdentifier(name));
  });
  it("preserves loaded history in incremental mode and truncates only in full mode", () => {
    const input = structuredClone(sales);
    input.options.incremental = true;
    const incremental = sql(input, "04_fact.sql");
    expect(sql(sales, "04_fact.sql")).toContain(
      "TRUNCATE TABLE [dw].[fact_sales]",
    );
    expect(incremental).not.toContain("TRUNCATE TABLE [dw].[fact_sales]");
    expect(incremental).toMatch(/MAX\(/);
    expect(incremental).toMatch(/<=\s*@Watermark/);
    expect(incremental).toContain("DELETE FROM [#DF_Candidates]");
    expect(sql(input, "03_dimensions.sql")).toContain("MERGE");
  });
  it("emits unknown calendar and dimension members plus rejection and lookup handling", () => {
    expect(sql(sales, "02_dim_date.sql")).toMatch(/-1/);
    expect(sql(sales, "03_dimensions.sql")).toContain("SET IDENTITY_INSERT");
    expect(sql(sales, "03_dimensions.sql")).toContain("ROW_NUMBER()");
    expect(sql(sales, "03_dimensions.sql")).not.toContain("ORDER BY (0)");
    const fact = sql(sales, "04_fact.sql");
    expect(fact).toContain("INSERT INTO [dw].[reject_rows]");
    expect(fact).toContain("TRY_CONVERT");
    expect(fact).toContain("FOR JSON PATH");
    expect(fact).toMatch(/COALESCE\([\s\S]*?-1\)/);
    expect(fact).toContain("CREATE CLUSTERED COLUMNSTORE INDEX");
    const checks = sql(sales, "05_checks.sql");
    expect(checks).toMatch(/TOP\s*\(?10\)?/);
    expect(checks).toContain("[raw_json]");
  });
  it("reflects edited aggregation choices without changing source-row grain", () => {
    const input = structuredClone(sales);
    input.model.fact.measures[0].aggregation = "MAX";
    const checks = sql(input, "05_checks.sql");
    expect(checks).toMatch(/MAX\(.*\[sales\]/);
    expect(checks).toMatch(/AVG\(.*\[discount\]/);
    expect(sql(input, "04_fact.sql")).not.toMatch(/GROUP BY/);
  });
  it("uses columnstore by default and upgrades generated clustered primary keys after loading", () => {
    const fact = sql(sales, "04_fact.sql");
    expect(fact).toContain(
      "CONSTRAINT [pk_fact_sales] PRIMARY KEY NONCLUSTERED",
    );
    expect(fact).toContain("[pk].[unique_index_id]");
    expect(fact).toContain("[i].[type] = 1");
    expect(fact).toContain(
      "ALTER TABLE [dw].[fact_sales] DROP CONSTRAINT [pk_fact_sales]",
    );
    expect(fact).toContain(
      "ADD CONSTRAINT [pk_fact_sales] PRIMARY KEY NONCLUSTERED ([fact_sales_key])",
    );
    expect(fact).toContain("AND [type] = 5");
    expect(fact).toContain(
      "CREATE CLUSTERED COLUMNSTORE INDEX [cci_fact_sales] ON [dw].[fact_sales]",
    );
    expect(fact.indexOf("CREATE CLUSTERED COLUMNSTORE INDEX")).toBeGreaterThan(
      fact.indexOf("SET @RowsOut = @@ROWCOUNT"),
    );
    expect(fact).not.toContain("CREATE NONCLUSTERED INDEX");
    for (const key of buildSqlContext(sales).foreignKeys)
      expect(fact).toContain(`DROP INDEX [ix_fact_sales_${key.name}]`);
    expect(fact).toContain("external incoming foreign keys");
    expect(fact).toContain("external clustered index");
    const oldDraft = structuredClone(sales);
    delete oldDraft.model.columnstore;
    expect(sql(oldDraft, "04_fact.sql")).toBe(fact);
  });
  it("restores rowstore and FK indexes when columnstore is disabled", () => {
    const input = structuredClone(sales);
    input.model.columnstore = false;
    const fact = sql(input, "04_fact.sql");
    expect(fact).toContain("CONSTRAINT [pk_fact_sales] PRIMARY KEY CLUSTERED");
    expect(fact).toContain("DROP INDEX [cci_fact_sales] ON [dw].[fact_sales]");
    expect(fact).toContain(
      "ADD CONSTRAINT [pk_fact_sales] PRIMARY KEY CLUSTERED",
    );
    expect(fact).not.toContain("CREATE CLUSTERED COLUMNSTORE INDEX");
    expect(fact.match(/CREATE NONCLUSTERED INDEX/g)).toHaveLength(4);
    expect(fact.indexOf("CREATE NONCLUSTERED INDEX")).toBeGreaterThan(
      fact.indexOf("SET @RowsOut = @@ROWCOUNT"),
    );
  });
  it("keeps normal incremental inserts into columnstore without rebuilding it", () => {
    const input = structuredClone(sales);
    input.options.incremental = true;
    const fact = sql(input, "04_fact.sql");
    expect(fact).toContain("INSERT INTO [dw].[fact_sales]");
    expect(fact).not.toContain("TRUNCATE TABLE [dw].[fact_sales]");
    expect(fact).not.toContain("DROP INDEX [cci_fact_sales]");
    expect(fact).not.toContain("REBUILD");
    expect(fact).toContain(
      "AND [type] = 5)\n    CREATE CLUSTERED COLUMNSTORE INDEX",
    );
  });
  it("handles no-date IRCC models without inventing a calendar or a date watermark", async () => {
    const input = await sampleInput("ircc-style.csv");
    input.options.incremental = true;
    expect(buildSqlContext(input).dateColumns).toHaveLength(0);
    expect(sql(input, "02_dim_date.sql")).not.toContain(
      "CREATE TABLE [dw].[dim_date]",
    );
    expect(sql(input, "04_fact.sql")).toContain("TRUNCATE TABLE");
  });
  it("uses a stable ordinary date business key as an incremental watermark", () => {
    const input = structuredClone(sales);
    const calendar = input.model.dimensions.find(
      (dimension) => dimension.generated === "date",
    )!;
    calendar.generated = null;
    calendar.name = "dim_order_day";
    calendar.businessKey = "1";
    calendar.attributes = [];
    input.options.incremental = true;
    const fact = sql(input, "04_fact.sql");
    expect(fact).toContain("MAX([loaded_date_dim].[order_date])");
    expect(fact).toContain("INNER JOIN [dw].[dim_order_day]");
    expect(fact).not.toContain("TRUNCATE TABLE");
    expect(sql(input, "05_checks.sql")).not.toContain(
      "AND @FactRows = @LoadedRows",
    );
  });
  it("refuses an incremental configuration whose dates cannot supply a stable persisted watermark", () => {
    const input = structuredClone(sales);
    const calendar = input.model.dimensions.find(
      (dimension) => dimension.generated === "date",
    )!;
    calendar.generated = null;
    calendar.columnIds = ["0", "1"];
    calendar.businessKey = "0";
    calendar.attributes = ["1"];
    input.model.fact.degenerateDimensions = [];
    input.model.fact.foreignKeys.find(
      (key) => key.dimensionId === calendar.id,
    )!.sourceColumnId = "0";
    input.options.incremental = true;
    expect(() => generateSql(input)).toThrow(
      /persisted.*date|date business key/i,
    );
    input.options.incremental = false;
    expect(sql(input, "04_fact.sql")).toContain("TRUNCATE TABLE");
  });
  it("reserves generated metadata and resolves edited identifier collisions deterministically", () => {
    const input = structuredClone(sales);
    input.model.columnNames["2"] = "source_row_number";
    input.model.columnNames["3"] = "Source Row Number";
    input.columns[2].name = "source_row_number";
    input.columns[3].name = "Source Row Number";
    input.model.dimensions[1].name = "Fact Sales";
    const context = buildSqlContext(input);
    expect(
      new Set([...context.stageColumns.values(), "source_row_number"]).size,
    ).toBe(12);
    expect(
      new Set([
        context.factTable,
        ...context.dimensions.map((dimension) => dimension.table),
      ]).size,
    ).toBe(5);
    const before = structuredClone(input);
    expect(generateSql(input)).toEqual(generateSql(input));
    expect(input).toEqual(before);
  });
});

/** Extract emitted standalone statements without cutting inside SQL strings or identifiers. */
function fragments(sqlText: string): string[] {
  const starts =
    /(?:^|\n)[ \t]*(USE\b|CREATE TABLE\b|CREATE (?:NONCLUSTERED |CLUSTERED COLUMNSTORE )?INDEX\b|TRUNCATE TABLE\b|INSERT INTO\b|SELECT TOP\b)/g;
  const results: string[] = [];
  const candidates = new Map(
    [...sqlText.matchAll(starts)].map((match) => [
      match.index! + match[0].indexOf(match[1]),
      match,
    ]),
  );
  const visibleStarts = new Set<number>();
  let depth = 0;
  let quoted: "string" | "identifier" | null = null;
  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index];
    if (quoted === "string") {
      if (char === "'" && sqlText[index + 1] === "'") index++;
      else if (char === "'") quoted = null;
    } else if (quoted === "identifier") {
      if (char === "]" && sqlText[index + 1] === "]") index++;
      else if (char === "]") quoted = null;
    } else if (char === "-" && sqlText[index + 1] === "-") {
      const newline = sqlText.indexOf("\n", index);
      index = newline < 0 ? sqlText.length : newline;
    } else if (char === "'") quoted = "string";
    else if (char === "[") quoted = "identifier";
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && candidates.has(index)) visibleStarts.add(index);
  }
  for (const match of sqlText.matchAll(starts)) {
    const start = match.index! + match[0].indexOf(match[1]);
    if (!visibleStarts.has(start)) continue;
    let quote: "string" | "identifier" | null = null;
    for (let index = start; index < sqlText.length; index++) {
      const char = sqlText[index];
      if (quote === "string") {
        if (char === "'" && sqlText[index + 1] === "'") index++;
        else if (char === "'") quote = null;
      } else if (quote === "identifier") {
        if (char === "]" && sqlText[index + 1] === "]") index++;
        else if (char === "]") quote = null;
      } else if (char === "'") quote = "string";
      else if (char === "[") quote = "identifier";
      else if (char === ";") {
        results.push(sqlText.slice(start, index + 1));
        break;
      }
    }
  }
  return results;
}

describe("transactsql parser coverage", () => {
  it("syntax-checks supported emitted statements from every generated file", () => {
    const parser = new Parser();
    const report: { file: string; parsed: number; skipped: string[] }[] = [];
    for (const file of generateSql(sales)) {
      let parsed = 0;
      const skipped: string[] = [];
      for (const statement of fragments(file.sql)) {
        // node-sql-parser 5.4 cannot parse these SQL Server constructs. Do not
        // rewrite them into another dialect or silently skip unknown failures.
        const unsupported = [
          [/FOREIGN KEY/i, "foreign-key DDL"],
          [/CREATE CLUSTERED COLUMNSTORE INDEX/i, "columnstore index DDL"],
          [
            /CONSTRAINT \[[^\]]+\] PRIMARY KEY/i,
            "named inline primary-key constraint",
          ],
          [/COUNT_BIG\s*\(\s*\*/i, "COUNT_BIG(*)"],
          [/FOR JSON PATH/i, "FOR JSON PATH"],
          [/SESSION_CONTEXT|sp_set_session_context/i, "session context"],
        ] as const;
        const skip = unsupported.find(([pattern]) => pattern.test(statement));
        if (skip) {
          skipped.push(skip[1]);
          continue;
        }
        expect(
          () => parser.astify(statement, { database: "transactsql" }),
          `${file.name}: ${statement}`,
        ).not.toThrow();
        parsed++;
      }
      expect(
        parsed,
        `${file.name} must have real parser coverage`,
      ).toBeGreaterThan(0);
      report.push({
        file: file.name,
        parsed,
        skipped: [...new Set(skipped)].sort(),
      });
    }
    expect(report).toMatchSnapshot();
  });
});
