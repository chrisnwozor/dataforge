import { describe, expect, it } from "vitest";
import {
  compileDistinctValues,
  compileQuery,
  QueryCompileError,
} from "@/lib/semantic/query/compile";
import { normalizeQuery } from "@/lib/semantic/query/schema";
import type {
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
} from "@/lib/semantic/types";

function fixture(): SemanticModel {
  const fact: SemanticTable = {
    id: "fact",
    name: "fact_sales",
    schema: "dw",
    sqlName: "fact_sales",
    kind: "fact",
    keyColumnId: "f:key",
    columns: [
      {
        id: "f:key",
        tableId: "fact",
        name: "Fact key",
        sqlName: "fact_key",
        role: "key",
        type: "number",
      },
      {
        id: "f:sales",
        tableId: "fact",
        name: "Sales",
        sqlName: "sales",
        role: "measure-source",
        type: "number",
      },
      {
        id: "f:qty",
        tableId: "fact",
        name: "Quantity",
        sqlName: "quantity",
        role: "measure-source",
        type: "number",
      },
      {
        id: "f:order",
        tableId: "fact",
        name: "Order ID",
        sqlName: "order_id",
        role: "attribute",
        type: "string",
      },
    ],
  };
  const dimensions: SemanticTable[] = [
    {
      id: "product",
      name: "dim_product",
      schema: "dw",
      sqlName: "dim_product",
      kind: "dimension",
      keyColumnId: "product:key",
      columns: [
        {
          id: "product:key",
          tableId: "product",
          name: "Product key",
          sqlName: "product_key",
          type: "number",
          role: "key",
        },
        {
          id: "product:category",
          tableId: "product",
          name: "Category",
          sqlName: "category",
          type: "string",
          role: "attribute",
        },
        {
          id: "product:name",
          tableId: "product",
          name: "Product",
          sqlName: "product",
          type: "string",
          role: "attribute",
        },
      ],
    },
    {
      id: "region",
      name: "dim_region",
      schema: "dw",
      sqlName: "dim_region",
      kind: "dimension",
      keyColumnId: "region:key",
      columns: [
        {
          id: "region:key",
          tableId: "region",
          name: "Region key",
          sqlName: "region_key",
          type: "number",
          role: "key",
        },
        {
          id: "region:name",
          tableId: "region",
          name: "Region",
          sqlName: "region",
          type: "string",
          role: "attribute",
        },
      ],
    },
    {
      id: "customer",
      name: "dim_customer",
      schema: "dw",
      sqlName: "dim_customer",
      kind: "dimension",
      keyColumnId: "customer:key",
      columns: [
        {
          id: "customer:key",
          tableId: "customer",
          name: "Customer key",
          sqlName: "customer_key",
          type: "number",
          role: "key",
        },
        {
          id: "customer:segment",
          tableId: "customer",
          name: "Segment",
          sqlName: "segment",
          type: "string",
          role: "attribute",
        },
      ],
    },
    {
      id: "date",
      name: "dim_date",
      schema: "dw",
      sqlName: "dim_date",
      kind: "dimension",
      keyColumnId: "date:key",
      columns: [
        {
          id: "date:key",
          tableId: "date",
          name: "DateKey",
          sqlName: "DateKey",
          type: "number",
          role: "key",
        },
        {
          id: "date:date",
          tableId: "date",
          name: "Date",
          sqlName: "Date",
          type: "date",
          role: "attribute",
        },
        {
          id: "date:year",
          tableId: "date",
          name: "Year",
          sqlName: "Year",
          type: "number",
          role: "attribute",
        },
      ],
    },
  ];
  for (const dimension of dimensions)
    fact.columns.push({
      id: `f:${dimension.id}`,
      tableId: "fact",
      name: `${dimension.id} FK`,
      sqlName: `${dimension.id}_key`,
      role: "key",
      type: "number",
    });
  const base: SemanticMeasure = {
    id: "sales",
    name: "Sales",
    expression: "SUM(fact_sales[Sales])",
    folder: "Measures",
    format: "currency",
    description: "",
    isAuto: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  return {
    projectId: "test",
    version: "1",
    factTableId: "fact",
    tables: [fact, ...dimensions],
    relationships: dimensions.map((dimension) => ({
      id: `rel:${dimension.id}`,
      fromTableId: "fact",
      fromColumnId: `f:${dimension.id}`,
      toTableId: dimension.id,
      toColumnId: dimension.keyColumnId,
      cardinality: "many-to-one",
    })),
    measures: [
      base,
      {
        ...base,
        id: "count",
        name: "Row Count",
        expression: "COUNT_BIG(*)",
        format: "number",
      },
    ],
    hierarchies: [],
    date: {
      tableId: "date",
      dateColumnId: "date:date",
      keyColumnId: "date:key",
      factColumnId: "f:date",
    },
  };
}

const category = { table: "product", column: "product:category" };
const year = { table: "date", column: "date:year" };
const region = { table: "region", column: "region:name" };
const segment = { table: "customer", column: "customer:segment" };
function expressionModel(expression: string): SemanticModel {
  const model = fixture();
  model.measures.push({
    ...model.measures[0],
    id: "test",
    name: "Test",
    expression,
    isAuto: false,
  });
  return model;
}

describe("semantic query validation and grouping", () => {
  it("normalizes defaults and rejects arbitrary SQL, oversize limits, duplicates and unsafe shapes", () => {
    expect(normalizeQuery({ measures: ["sales"] })).toEqual({
      measures: ["sales"],
      rows: [],
      filters: [],
      orderBy: [],
      limit: 1000,
      hideUnknown: true,
    });
    expect(() =>
      normalizeQuery({ measures: ["sales"], sql: "DROP TABLE x" }),
    ).toThrow();
    expect(() =>
      normalizeQuery({ measures: ["sales"], limit: 50_001 }),
    ).toThrow();
    expect(() =>
      normalizeQuery({
        measures: ["sales"],
        filters: [{ attribute: category, op: "in" }],
      }),
    ).toThrow();
    expect(() =>
      compileQuery(fixture(), { measures: ["sales", "Sales"] }),
    ).toThrow("once");
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        rows: [category],
        columns: [category],
      }),
    ).toThrow("once");
    expect(() => compileQuery(fixture(), { measures: ["SELECT 1"] })).toThrow(
      "Unknown measure",
    );
  });

  it("compiles no-group totals with one aggregate row and no unreferenced dimension joins", () => {
    const result = compileQuery(fixture(), {
      measures: ["sales", "Row Count"],
    });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).not.toContain("JOIN");
    expect(result.sql).not.toContain("GROUP BY");
    expect(result.params).toEqual([
      { name: "__df_limit", value: 1001, type: "number" },
    ]);
  });

  it("compiles one dimension and excludes Unknown only on its foreign key", () => {
    const result = compileQuery(fixture(), {
      measures: ["Sales"],
      rows: [category],
    });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql.match(/LEFT JOIN/g)).toHaveLength(1);
    expect(result.sql).toContain("[f].[product_key] <> -1");
    expect(result.sql).not.toContain("region_key");
    expect(
      compileQuery(fixture(), {
        measures: ["sales"],
        rows: [category],
        hideUnknown: false,
      }).sql,
    ).not.toContain("<> -1");
  });

  it("compiles a three-dimension grouped query with deterministic selected ordering and Top N", () => {
    const result = compileQuery(fixture(), {
      measures: ["sales", "count"],
      rows: [category, region, segment],
      topN: { measure: "sales", n: 10 },
      orderBy: [{ ref: region, dir: "asc" }],
    });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql.match(/LEFT JOIN/g)).toHaveLength(3);
    expect(result.limit).toBe(10);
    expect(result.params.at(-1)?.value).toBe(11);
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        orderBy: [{ ref: "missing", dir: "desc" }],
      }),
    ).toThrow("Order by");
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        topN: { measure: "count", n: 10 },
      }),
    ).toThrow("Select the Top N measure");
  });

  it("keeps constant expressions aggregated to one no-group row", () => {
    const result = compileQuery(expressionModel("42"), { measures: ["test"] });
    expect(result.sql).toContain("COUNT_BIG(*) AS [__df_group_count]");
    expect(result.params[0].value).toBe(42);
  });

  it("returns long pivot rows with a hard 50-column-tuple cap and a truncation signal", () => {
    const result = compileQuery(fixture(), {
      measures: ["sales"],
      rows: [category],
      columns: [region, segment],
    });
    expect(result.sql).toMatchSnapshot();
    expect(result.pivot).toEqual({
      rowKeys: ["a0"],
      columnKeys: ["a1", "a2"],
      measureKeys: ["m0"],
    });
    expect(result.sql).toContain("[r].[__df_pivot_rank] <= 50");
    expect(result.sql).toContain("[r].[__df_pivot_total]");
  });
});

describe("semantic query expressions and context", () => {
  it("uses conditional aggregation for joined CALCULATE filters with every literal bound", () => {
    const model = expressionModel(
      "CALCULATE([Sales], dim_product[Category] IN ('Furniture', 'Office Supplies'))",
    );
    const result = compileQuery(model, { measures: ["test"], rows: [region] });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).toContain("SUM(CAST(CASE WHEN");
    expect(result.sql).not.toContain("Furniture");
    expect(result.params.map((param) => param.value)).toContain("Furniture");
    expect(result.sql.match(/LEFT JOIN/g)).toHaveLength(2);
  });

  it("implements ALL with a correlated pre-aggregation scope independent of that grouping and slicer", () => {
    const result = compileQuery(
      expressionModel(
        "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[Category])))",
      ),
      {
        measures: ["test"],
        rows: [category, region],
        filters: [{ attribute: category, op: "eq", value: "Furniture" }],
      },
    );
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).toContain("FROM [__df_base] AS [b]");
    expect(result.sql).toContain("[g].[a1]");
    expect(
      result.params.filter((param) => param.value === "Furniture"),
    ).toHaveLength(2);
    // The grand-total subquery does not correlate category and does not repeat its slicer.
    const denominator = result.sql.slice(result.sql.indexOf("/ NULLIF("));
    expect(denominator).not.toContain("[g].[a0]");
  });

  it.each(["YTD", "MTD", "QTD", "SAMEPERIODLASTYEAR"])(
    "compiles %s with calendar range joins and preserves non-date groups",
    (fn) => {
      const result = compileQuery(expressionModel(`${fn}([Sales])`), {
        measures: ["test"],
        rows: [year, category],
        filters: [
          { attribute: year, op: "eq", value: 2025 },
          { attribute: region, op: "eq", value: "West" },
        ],
      });
      expect(result.sql).toMatchSnapshot();
      expect(result.sql).toContain("MIN([b].");
      expect(result.sql).toContain("[g].[__df_end]");
      expect(result.sql).toContain("[g].[a1]");
      const measureSql = result.sql.slice(
        result.sql.indexOf("(SELECT SUM("),
        result.sql.indexOf(" AS [m0]"),
      );
      expect(measureSql).not.toContain("[g].[a0]");
      expect(
        result.params.filter((param) => param.value === 2025),
      ).toHaveLength(1);
      expect(
        result.params.filter((param) => param.value === "West"),
      ).toHaveLength(2);
    },
  );

  it.each(["MONTH", "QUARTER", "YEAR"])(
    "compiles PREVIOUSPERIOD %s without interpolating the period request",
    (period) => {
      const result = compileQuery(
        expressionModel(`PREVIOUSPERIOD([Sales], ${period})`),
        { measures: ["test"], rows: [year] },
      );
      expect(result.sql).toMatchSnapshot();
      expect(result.sql).toContain(`DATEADD(${period}, -1, DATEFROMPARTS`);
    },
  );

  it("compiles YoY and scalar expressions without nested SQL aggregates", () => {
    const model = expressionModel(
      "IF([Row Count] > 0, ROUND(ABS(DIVIDE([Sales] - SAMEPERIODLASTYEAR([Sales]), SAMEPERIODLASTYEAR([Sales]), 0)), 2), NULL)",
    );
    const result = compileQuery(model, { measures: ["test"], rows: [year] });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).toContain("CASE WHEN");
    expect(result.sql).toContain("NULLIF");
    expect(result.sql).not.toMatch(/SUM\(SUM\(/);
  });

  it("rejects cycles and date functions without a calendar", () => {
    const model = expressionModel("[Test]");
    expect(() => compileQuery(model, { measures: ["test"] })).toThrow("cycle");
    const noDate = expressionModel("YTD([Sales])");
    delete noDate.date;
    expect(() => compileQuery(noDate, { measures: ["test"] })).toThrow(
      "date dimension",
    );
  });

  it("applies DIVIDE's alternate only for a null or zero denominator, preserving a null numerator", () => {
    const result = compileQuery(expressionModel("DIVIDE(NULL, 2, 99)"), {
      measures: ["test"],
    });
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).not.toContain("COALESCE");
    expect(result.sql).toContain(
      "CASE WHEN @p1 IS NULL OR @p1 = 0 THEN @p2 ELSE CAST(@p0 AS FLOAT)",
    );
  });

  it("widens numeric SUM and AVG sources so valid integers do not overflow or truncate averages", () => {
    const sum = compileQuery(fixture(), { measures: ["sales"] });
    const average = compileQuery(expressionModel("AVG(fact_sales[Quantity])"), {
      measures: ["test"],
    });
    expect(sum.sql).toContain("SUM(CAST([f].[sales] AS DECIMAL(38, 10)))");
    expect(average.sql).toContain("AVG(CAST([f].[quantity] AS FLOAT))");
  });

  it("lets inner CALCULATE filters and ALL replace earlier filters on the same column", () => {
    const cleared = compileQuery(
      expressionModel(
        "CALCULATE(CALCULATE([Sales], ALL(dim_product[Category])), dim_product[Category] = 'Office')",
      ),
      { measures: ["test"] },
    );
    expect(cleared.sql).not.toContain("CASE WHEN");
    expect(cleared.params.some((param) => param.value === "Office")).toBe(
      false,
    );
    const replaced = compileQuery(
      expressionModel(
        "CALCULATE(CALCULATE([Sales], dim_product[Category] = 'Furniture'), dim_product[Category] = 'Office')",
      ),
      { measures: ["test"] },
    );
    expect(replaced.params.some((param) => param.value === "Furniture")).toBe(
      true,
    );
    expect(replaced.params.some((param) => param.value === "Office")).toBe(
      false,
    );
  });

  it("uses a preaggregation scope when CALCULATE replaces a grouping or slicer column", () => {
    const result = compileQuery(
      expressionModel(
        "CALCULATE([Sales], dim_product[Category] = 'Furniture')",
      ),
      {
        measures: ["test"],
        rows: [category],
        filters: [{ attribute: category, op: "eq", value: "Office" }],
      },
    );
    expect(result.sql).toMatchSnapshot();
    const measureSql = result.sql.slice(
      result.sql.indexOf("(SELECT SUM("),
      result.sql.indexOf(" AS [m0]"),
    );
    expect(measureSql).not.toContain("[g].[a0]");
    expect(
      result.params.filter((param) => param.value === "Office"),
    ).toHaveLength(1);
  });

  it("recomputes time anchors under CALCULATE filters, then removes date restrictions for the shifted range", () => {
    const result = compileQuery(
      expressionModel("CALCULATE(YTD([Sales]), dim_date[Year] = 2024)"),
      { measures: ["test"], rows: [category] },
    );
    expect(result.sql).toMatchSnapshot();
    expect(result.sql).toContain("YEAR((SELECT MAX(");
    expect(result.sql).not.toContain("CASE WHEN");
    expect(
      result.params.filter((param) => param.value === 2024).length,
    ).toBeGreaterThan(0);
    const allDate = compileQuery(
      expressionModel("CALCULATE(YTD([Sales]), ALL(dim_date[Year]))"),
      {
        measures: ["test"],
        rows: [year],
        filters: [{ attribute: year, op: "eq", value: 2025 }],
      },
    );
    const anchorSql = allDate.sql.slice(
      allDate.sql.indexOf("YEAR((SELECT MAX("),
    );
    expect(anchorSql).not.toContain("[g].[a0]");
    expect(allDate.params.filter((param) => param.value === 2025)).toHaveLength(
      1,
    );
  });

  it("gives explicit null membership to CALCULATE IN and NOT IN filters", () => {
    const included = compileQuery(
      expressionModel(
        "CALCULATE([Sales], dim_product[Category] IN ('Furniture', NULL))",
      ),
      { measures: ["test"] },
    );
    const excluded = compileQuery(
      expressionModel(
        "CALCULATE([Sales], dim_product[Category] NOT IN ('Furniture', NULL))",
      ),
      { measures: ["test"] },
    );
    expect(included.sql).toMatch(/IN \(@p0\) OR .* IS NULL/);
    expect(excluded.sql).toMatch(/NOT IN \(@p0\) AND .* IS NOT NULL/);
  });

  it("limits expanded rendered SQL and surfaces invalid expressions as request errors", () => {
    const model = fixture();
    let previous = "Sales";
    for (let i = 0; i < 16; i++) {
      model.measures.push({
        ...model.measures[0],
        id: `expanded:${i}`,
        name: `Expanded ${i}`,
        expression: `DIVIDE(1, [${previous}])`,
      });
      previous = `Expanded ${i}`;
    }
    expect(() => compileQuery(model, { measures: ["expanded:15"] })).toThrow(
      "too complex",
    );
    try {
      compileQuery(expressionModel("SUM(fact_sales[Missing])"), {
        measures: ["test"],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(QueryCompileError);
      expect((error as QueryCompileError).status).toBe(400);
    }
  });
});

describe("semantic query injection and filter boundaries", () => {
  it("binds quotes, brackets, SQL comments and semicolons in filter values", () => {
    const attack = "Furniture']; DROP TABLE [dw].[fact_sales]; -- /* */";
    const result = compileQuery(fixture(), {
      measures: ["sales"],
      rows: [category],
      filters: [{ attribute: category, op: "eq", value: attack }],
    });
    expect(result.sql).not.toContain(attack);
    expect(result.params).toContainEqual({
      name: "p0",
      value: attack,
      type: "string",
    });
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        rows: [{ table: "product;DROP TABLE x--", column: "Category" }],
      }),
    ).toThrow(QueryCompileError);
  });

  it("bracket-quotes every trusted SQL identifier including hostile model names", () => {
    const model = fixture();
    const product = model.tables.find((table) => table.id === "product")!;
    product.schema = "dw] ; --";
    product.sqlName = "product]DROP TABLE x;--";
    product.columns.find((column) => column.id === category.column)!.sqlName =
      "category] /* x */ ;";
    const result = compileQuery(model, {
      measures: ["sales"],
      rows: [category],
    });
    expect(result.sql).toContain("[dw]] ; --].[product]]DROP TABLE x;--]");
    expect(result.sql).toContain("[category]] /* x */ ;]");
  });

  it("uses short generated SQL aliases for long or reserved opaque model IDs", () => {
    const model = fixture();
    const longId = "source:" + "x".repeat(200);
    model.tables
      .find((table) => table.id === "product")!
      .columns.find((column) => column.id === category.column)!.id = longId;
    model.measures[0].id = "__df_pivot_total";
    const result = compileQuery(model, {
      measures: ["__df_pivot_total"],
      rows: [{ table: "product", column: longId }],
      columns: [region],
      topN: { measure: "__df_pivot_total", n: 5 },
      orderBy: [{ ref: longId, dir: "asc" }],
    });
    expect(result.columns.map((column) => column.key)).toEqual([
      "a0",
      "a1",
      "m0",
    ]);
    expect(result.sql).not.toContain(longId);
    expect(result.sql).toContain("[r].[m0] DESC");
    expect(result.sql).toContain("[r].[a0] ASC");
  });

  it("handles empty/null IN filters and disallows inappropriate typed comparisons", () => {
    const result = compileQuery(fixture(), {
      measures: ["sales"],
      filters: [{ attribute: category, op: "in", values: ["Furniture", null] }],
    });
    expect(result.sql).toMatch(/IN \(@p0\) OR .* IS NULL/);
    expect(
      compileQuery(fixture(), {
        measures: ["sales"],
        filters: [{ attribute: category, op: "in", values: [] }],
      }).sql,
    ).toContain("1 = 0");
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        filters: [{ attribute: year, op: "eq", value: "2024" }],
      }),
    ).toThrow("type number");
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        filters: [
          {
            attribute: { table: "date", column: "date:date" },
            op: "eq",
            value: "2024-02-30",
          },
        ],
      }),
    ).toThrow("valid ISO date");
    expect(() =>
      compileQuery(fixture(), {
        measures: ["sales"],
        filters: [{ attribute: category, op: "gt", value: null }],
      }),
    ).toThrow("NULL supports");
  });

  it("accepts numeric source predicates without allowing raw numeric grouping", () => {
    const numericSource = { table: "fact", column: "f:sales" };
    const result = compileQuery(fixture(), {
      measures: ["sales"],
      filters: [{ attribute: numericSource, op: "gt", value: 0 }],
    });
    expect(result.sql).toContain("[f].[sales] > @p0");
    expect(() =>
      compileQuery(fixture(), { measures: ["sales"], rows: [numericSource] }),
    ).toThrow("measure source");
  });

  it("rejects requests that would exceed the SQL Server parameter budget", () => {
    const filters = Array.from({ length: 3 }, () => ({
      attribute: category,
      op: "in",
      values: Array.from({ length: 1000 }, (_, i) => String(i)),
    }));
    expect(() =>
      compileQuery(fixture(), { measures: ["sales"], filters }),
    ).toThrow("too many parameter values");
  });

  it("compiles capped distinct values and counts using the same safe model joins", () => {
    const result = compileDistinctValues(fixture(), category);
    expect(result.sql).toMatchSnapshot();
    expect(result.columns.map((column) => column.key)).toEqual([
      "value",
      "count",
    ]);
    expect(result.limit).toBe(1000);
    expect(result.params).toEqual([
      { name: "__df_limit", value: 1001, type: "number" },
    ]);
  });
});
