import { describe, expect, it } from "vitest";
import {
  compile,
  ExpressionError,
  parse,
  resolveExpression,
  tokenize,
} from "@/lib/semantic/expr";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
} from "@/lib/semantic/types";

const column = (
  tableId: string,
  id: string,
  name: string,
  type: SemanticColumn["type"],
  role: SemanticColumn["role"] = "attribute",
): SemanticColumn => ({ tableId, id, name, sqlName: name, type, role });
const fact: SemanticTable = {
  id: "fact",
  name: "fact_sales",
  schema: "dw",
  sqlName: "fact_sales",
  kind: "fact",
  keyColumnId: "fact-key",
  columns: [
    column("fact", "fact-key", "sales_key", "number", "key"),
    column("fact", "sales", "Sales", "number", "measure-source"),
    column("fact", "profit", "Profit", "number", "measure-source"),
    column("fact", "quantity", "Quantity", "number", "measure-source"),
    column("fact", "order", "Order ID", "string"),
    column("fact", "date-fk", "DateKey", "number", "key"),
    column("fact", "product-fk", "ProductKey", "number", "key"),
  ],
};
const date: SemanticTable = {
  id: "date",
  name: "dim_date",
  sqlName: "dim_date",
  schema: "dw",
  kind: "dimension",
  keyColumnId: "date-key",
  columns: [
    column("date", "date-key", "DateKey", "number", "key"),
    column("date", "date-value", "Date", "date"),
    column("date", "year", "Year", "number"),
  ],
};
const product: SemanticTable = {
  id: "product",
  name: "dim_product",
  sqlName: "dim_product",
  schema: "dw",
  kind: "dimension",
  keyColumnId: "product-key",
  columns: [
    column("product", "product-key", "product_key", "number", "key"),
    column("product", "category", "Category", "string"),
    column("product", "product-name", "Product", "string"),
  ],
};
const measure = (
  id: string,
  name: string,
  expression: string,
): SemanticMeasure => ({
  id,
  name,
  expression,
  format: "number",
  folder: "",
  description: "",
  isAuto: false,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
});
function model(): SemanticModel {
  return {
    projectId: "project",
    version: "version",
    factTableId: "fact",
    tables: structuredClone([fact, date, product]),
    date: {
      tableId: "date",
      dateColumnId: "date-value",
      keyColumnId: "date-key",
      factColumnId: "date-fk",
    },
    relationships: [
      {
        id: "date-link",
        fromTableId: "fact",
        fromColumnId: "date-fk",
        toTableId: "date",
        toColumnId: "date-key",
        cardinality: "many-to-one",
      },
      {
        id: "product-link",
        fromTableId: "fact",
        fromColumnId: "product-fk",
        toTableId: "product",
        toColumnId: "product-key",
        cardinality: "many-to-one",
      },
    ],
    measures: [
      measure("total-sales", "Total Sales", "SUM(fact_sales[Sales])"),
      measure("total-profit", "Total Profit", "SUM(fact_sales[Profit])"),
      measure("margin", "Margin", "DIVIDE([Total Profit], [Total Sales])"),
    ],
    hierarchies: [],
  };
}

describe("expression tokenizer and parser", () => {
  it("tracks source positions and handles escaped strings and references", () => {
    expect(tokenize(" 'O''Brien' + [A]]B] ").slice(0, -1)).toEqual([
      { kind: "string", value: "O'Brien", pos: 1, end: 11 },
      { kind: "operator", value: "+", pos: 12, end: 13 },
      { kind: "reference", value: "A]B", pos: 14, end: 20 },
    ]);
  });
  it("honors arithmetic, comparison, NOT, AND, and OR precedence", () => {
    const ast = parse("NOT 1 + 2 * 3 > 8 AND TRUE OR FALSE");
    expect(ast).toMatchObject({
      kind: "binary",
      op: "OR",
      left: {
        kind: "binary",
        op: "AND",
        left: {
          kind: "unary",
          op: "NOT",
          operand: {
            kind: "binary",
            op: ">",
            left: { op: "+", right: { op: "*" } },
          },
        },
      },
    });
  });
  it.each(["NOT", "AND", "OR", "(", ")", ",", "+", "-", "MONTH"])(
    "keeps quoted %s as a string literal",
    (value) => {
      expect(parse(`'${value}'`)).toMatchObject({ kind: "literal", value });
      expect(
        compile(`IF(TRUE, '${value}', NULL)`, model()).params.some(
          (parameter) => parameter.value === value,
        ),
      ).toBe(true);
      expect(
        compile(
          `CALCULATE([Total Sales], dim_product[Category] = '${value}')`,
          model(),
        ).params.some((parameter) => parameter.value === value),
      ).toBe(true);
    },
  );
  it("parses quoted table names, decimals, exponents, and NOT IN", () => {
    expect(parse("'fact sales'[Revenue] NOT IN (-1, .5, 2e3)")).toMatchObject({
      kind: "in",
      negated: true,
      expression: {
        kind: "column",
        tableName: "fact sales",
        columnName: "Revenue",
      },
      values: [{ kind: "unary", op: "-" }, { value: 0.5 }, { value: 2000 }],
    });
  });
  it.each([
    "",
    " ",
    "'missing",
    "[missing",
    "SUM(",
    "1; DROP TABLE x",
    "1 -- comment",
    "1 /* comment */",
    "1 @ x",
    "1 2",
    "1 IN ()",
    "1e999",
    "SUM(fact_sales[Sales],)",
  ])("rejects invalid syntax: %s", (expression) => {
    expect(() => parse(expression)).toThrow(ExpressionError);
  });
  it("limits source length and nesting before recursive parsing", () => {
    expect(() => parse("1".repeat(2001))).toThrow("2,000");
    expect(() => parse("(".repeat(13) + "1" + ")".repeat(13))).toThrow(
      "12 levels",
    );
    expect(() => parse("ABS(".repeat(13) + "1" + ")".repeat(13))).toThrow(
      "12 levels",
    );
    expect(parse("(".repeat(12) + "1" + ")".repeat(12))).toMatchObject({
      value: 1,
    });
  });
});

describe("expression type checking and resolution", () => {
  it.each([
    ["SUM(fact_sales[Sales])", "number"],
    ["COUNT_BIG(*)", "number"],
    ["DISTINCTCOUNT(fact_sales[Order ID])", "number"],
    ["MIN(fact_sales[Order ID])", "string"],
    ["DIVIDE([Total Profit], [Total Sales], NULL)", "number"],
    ["IF(NOT [Total Sales] > 0, 0, ROUND(ABS([Total Profit]), -2))", "number"],
    [
      "CALCULATE([Total Sales], dim_product[Category] IN ('Office', 'Furniture'))",
      "number",
    ],
    ["CALCULATE([Total Sales], dim_product[Category] = NULL)", "number"],
    ["CALCULATE([Total Sales], ALL(dim_product[Category]))", "number"],
    ["PREVIOUSPERIOD([Total Sales], QUARTER)", "number"],
    ["NULL", "null"],
    ["TRUE AND NOT FALSE", "boolean"],
  ])("accepts %s as %s", (expression, type) => {
    expect(resolveExpression(expression, model()).type).toBe(type);
  });
  it.each([
    ["fact_sales[Sales]", "aggregated"],
    ["SUM(dim_product[Product])", "fact-table"],
    ["SUM(fact_sales[Order ID])", "numeric"],
    ["AVG(4)", "fact-table"],
    ["SUM(*)", "Only COUNT"],
    ["SUM()", "expects 1"],
    ["IF(1, 2, 3)", "boolean"],
    ["[Total Sales] + 'text'", "numeric"],
    ["IF(TRUE, 2, 'text')", "Cannot compare"],
    ["DIVIDE(1)", "expects 2"],
    ["ABS('text')", "numeric"],
    ["ROUND(1, 2.5)", "integer literal"],
    ["ROUND(1, [Total Sales])", "integer literal"],
    ["CALCULATE([Total Sales], [Total Profit] > 0)", "Table[Column]"],
    ["CALCULATE([Total Sales], dim_product[Category] = 2)", "Cannot compare"],
    [
      "CALCULATE([Total Sales], fact_sales[Sales] IN ([Total Sales]))",
      "CALCULATE expects",
    ],
    ["ALL(dim_product[Category])", "only valid"],
    ["MONTH", "only valid"],
    ["PREVIOUSPERIOD([Total Sales], 'MONTH')", "MONTH, QUARTER"],
    ["YTD('wrong')", "numeric"],
  ])("rejects invalid types/contexts: %s", (expression, message) => {
    expect(() => resolveExpression(expression, model())).toThrow(message);
  });
  it("provides positioned unknown-name suggestions", () => {
    for (const [expression, position] of [
      ["[Total Sale]", 0],
      ["SUM(fact_sale[Sales])", 4],
      ["SUM(fact_sales[Slaes])", 4],
      ["SOM(fact_sales[Sales])", 0],
    ] as const) {
      try {
        resolveExpression(expression, model());
        throw new Error("should reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ExpressionError);
        expect((error as ExpressionError).toIssue()).toMatchObject({
          position,
          suggestion: expect.any(String),
          message: expect.stringContaining("Did you mean"),
        });
      }
    }
  });
  it("requires dim_date for time functions", () => {
    const noDate = model();
    delete noDate.date;
    expect(() => resolveExpression("YTD([Total Sales])", noDate)).toThrow(
      "date dimension",
    );
  });
  it("validates date filter literals before reaching SQL Server", () => {
    expect(
      resolveExpression(
        "CALCULATE([Total Sales], dim_date[Date] >= '2024-02-29')",
        model(),
      ).type,
    ).toBe("number");
    for (const value of [
      "oops",
      "2024-02-30",
      "0000-01-01",
      "2023-02-29",
      "2024-1-1",
    ]) {
      expect(() =>
        resolveExpression(
          `CALCULATE([Total Sales], dim_date[Date] = '${value}')`,
          model(),
        ),
      ).toThrow(/date|ISO/);
    }
  });
  it("resolves names case-insensitively and returns unique transitive measure dependencies", () => {
    const checked = resolveExpression("[margin] + [TOTAL SALES]", model());
    expect(checked.dependencies).toEqual([
      "margin",
      "total-profit",
      "total-sales",
    ]);
    expect(checked.ast.kind).toBe("binary");
  });
  it("detects self and indirect cycles with a useful path", () => {
    const cyclic = model();
    cyclic.measures.push(
      measure("cycle-a", "A", "[B]"),
      measure("cycle-b", "B", "[A]"),
    );
    expect(() => resolveExpression("[A]", cyclic)).toThrow("A → B → A");
    cyclic.measures.push(measure("self", "Self", "[Self]"));
    expect(() => resolveExpression("[Self]", cyclic)).toThrow("Self → Self");
  });
  it("limits referenced measures and expanded DAG size", () => {
    const excessive = model();
    excessive.measures = Array.from({ length: 65 }, (_, index) =>
      measure(`m${index}`, `M${index}`, index === 64 ? "1" : `[M${index + 1}]`),
    );
    expect(() => resolveExpression("[M0]", excessive)).toThrow("64 measures");
    excessive.measures = Array.from({ length: 20 }, (_, index) =>
      measure(
        `m${index}`,
        `M${index}`,
        index === 19 ? "1" : `[M${index + 1}] + [M${index + 1}]`,
      ),
    );
    expect(() => resolveExpression("[M0]", excessive)).toThrow("too complex");
  });
  it("limits SQL expansion before nested denominator reuse can allocate unbounded text", () => {
    const excessive = model();
    excessive.measures = Array.from({ length: 40 }, (_, index) =>
      measure(
        `m${index}`,
        `M${index}`,
        index === 39 ? "1" : `DIVIDE(1, [M${index + 1}])`,
      ),
    );
    expect(() => compile("[M0]", excessive)).toThrow("maximum 256 KiB");
  });
});

describe("parameterized SQL expression compilation", () => {
  const examples: Record<string, string> = {
    aggregations:
      "SUM(fact_sales[Sales]) + AVG(fact_sales[Profit]) + MIN(fact_sales[Sales]) + MAX(fact_sales[Quantity]) + COUNT(fact_sales[Order ID]) + DISTINCTCOUNT(fact_sales[Order ID]) + COUNT_BIG(*)",
    divide: "DIVIDE([Total Profit], [Total Sales], 0)",
    scalar:
      "IF(NOT [Total Sales] > 100 AND TRUE, ROUND(ABS([Total Profit]), 2), NULL)",
    calculate: "CALCULATE([Total Sales], dim_product[Category] = 'Furniture')",
    calculateIn:
      "CALCULATE([Total Sales], dim_product[Category] IN ('Office', 'Furniture', NULL), fact_sales[Quantity] >= 2)",
    calculateAll:
      "CALCULATE(CALCULATE([Total Sales], ALL(dim_product[Category])), dim_product[Category] = 'Office')",
    ytd: "YTD([Total Sales])",
    mtd: "MTD([Total Sales])",
    qtd: "QTD([Total Sales])",
    ly: "SAMEPERIODLASTYEAR([Total Sales])",
    previousMonth: "PREVIOUSPERIOD([Total Sales], MONTH)",
    previousQuarter: "PREVIOUSPERIOD([Total Sales], QUARTER)",
    previousYear: "PREVIOUSPERIOD([Total Sales], YEAR)",
    yoy: "DIVIDE([Total Sales] - SAMEPERIODLASTYEAR([Total Sales]), SAMEPERIODLASTYEAR([Total Sales]))",
  };
  it.each(Object.entries(examples))("snapshots %s", (name, expression) => {
    const result = compile(expression, model());
    expect({
      sql: result.sql,
      params: result.params,
      dependencies: result.dependencies,
    }).toMatchSnapshot(name);
    expect(result.sql).not.toMatch(
      /\b(?:EXEC|INSERT|UPDATE|DELETE|DROP|CREATE)\b/,
    );
  });
  it("never interpolates string values, including SQL syntax", () => {
    const value = "O'Brien]; DROP TABLE [dw].[fact_sales]; -- /*";
    const result = compile(
      `CALCULATE([Total Sales], dim_product[Category] = '${value.replace(/'/g, "''")}')`,
      model(),
    );
    expect(result.sql).not.toContain(value);
    expect(result.sql).not.toContain("DROP");
    expect(result.params).toEqual([{ name: "p0", value, type: "string" }]);
  });
  it("quotes trusted model identifiers containing quotes, brackets and SQL-looking names", () => {
    const injected = model();
    injected.tables[0].sqlName = "fact'; --]sales";
    injected.tables[0].columns.find((item) => item.id === "sales")!.sqlName =
      "Sales]; DROP TABLE x; --";
    const result = compile("SUM(fact_sales[Sales])", injected);
    expect(result.sql).toContain("[dw].[fact'; --]]sales]");
    expect(result.sql).toContain("[f].[Sales]]; DROP TABLE x; --]");
  });
  it("supports escaped display/reference names without interpreting them as SQL", () => {
    const escaped = model();
    escaped.tables[0].name = "Fact O'Brien";
    escaped.tables[0].columns.find((item) => item.id === "sales")!.name =
      "Sales] value";
    expect(
      compile("SUM('Fact O''Brien'[Sales]] value])", escaped).sql,
    ).toContain("[f].[Sales]");
  });
  it("compiles safe division and null predicates without scalar UDFs or cursors", () => {
    const result = compile(
      "CALCULATE([Total Sales] / 0, dim_product[Category] <> NULL)",
      model(),
    );
    expect(result.sql).toContain("NULLIF");
    expect(result.sql).toContain("IS NOT NULL");
    expect(result.sql).not.toMatch(/CURSOR|FUNCTION|EXEC/i);
  });
  it("preserves SQL's three-valued boolean result for null comparisons", () => {
    expect(compile("NULL > 1", model()).sql).toContain(
      "ELSE CAST(NULL AS BIT)",
    );
    expect(compile("NOT NULL", model()).sql).toContain("WHEN NOT");
  });
});
