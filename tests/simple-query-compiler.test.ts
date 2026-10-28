import { beforeAll, describe, expect, it } from "vitest";
import { compileDistinctValues, compileQuery, QueryCompileError } from "@/lib/semantic/query/compile";
import { QUERY_PLAN_HINTS } from "@/lib/semantic/query/hints";
import type { SemanticModel } from "@/lib/semantic/types";
import { categoryReference, createSuperstoreSemanticFixture, productCategoryReferences } from "./fixtures/superstore-semantic";

let model: SemanticModel;
beforeAll(async () => { model = await createSuperstoreSemanticFixture(); });

function withMeasure(name: string, expression: string): SemanticModel {
  return {
    ...model, version: `${model.version}:${name}:${expression}`,
    measures: [...model.measures, { id: `plain:${name}`, name, expression, format: "number", folder: "Tests", description: "", isAuto: false, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" }],
  };
}

const factColumn = (name: string) => {
  const table = model.tables.find((table) => table.id === model.factTableId)!;
  const column = table.columns.find((column) => column.name === name)!;
  return `${table.name}[${column.name.replaceAll("]", "]]")}]`;
};

function expectFast(sql: string) {
  expect(sql.match(/\bSELECT\b/gi)).toHaveLength(1);
  expect(sql.match(/\bFROM\s+\[dw\]\.\[fact_sales\]/gi)).toHaveLength(1);
  expect(sql.match(/\bGROUP\s+BY\b/gi)).toHaveLength(1);
  expect(sql).not.toMatch(/#df_|DENSE_RANK|\bOVER\s*\(|\bWITH\b|\bINTO\b|CROSS\s+APPLY/i);
  expect(sql).toContain(QUERY_PLAN_HINTS);
}

describe("single-statement aggregate compiler", () => {
  it("snapshots Sales by Category with one warehouse read and grouping operator", () => {
    const compiled = compileQuery(model, { measures: ["Sales"], rows: [categoryReference(model)] });
    expect(compiled.materialized).toBe(false);
    expectFast(compiled.sql);
    expect(compiled.sql).toMatchSnapshot();
    expect(compiled.params).toEqual([{ name: "__df_limit", value: 1001, type: "number" }]);
  });

  it("snapshots ratios in the same GROUP BY with typed filters, ranking and ordering", () => {
    const compiled = compileQuery(model, {
      measures: ["Sales", "Profit Margin %", "Quantity", "Discount", "Profit"],
      rows: productCategoryReferences(model),
      filters: [{ attribute: categoryReference(model), op: "eq", value: "Furniture" }],
      topN: { measure: "Sales", n: 10 },
      orderBy: [{ ref: "Profit Margin %", dir: "desc" }],
    });
    expectFast(compiled.sql);
    expect(compiled.materialized).toBe(false);
    expect(compiled.limit).toBe(10);
    expect(compiled.sql).not.toContain("Furniture");
    expect(compiled.sql).toContain("NULLIF(SUM(");
    expect(compiled.sql).toMatchSnapshot();
  });

  it.each(["SUM", "COUNT", "COUNT_BIG", "MIN", "MAX", "AVG"])("compiles %s over a fact column without materialization", (name) => {
    const changed = withMeasure(`Plain ${name}`, `${name}(${factColumn("Sales")})`);
    const compiled = compileQuery(changed, { measures: [`Plain ${name}`], rows: [categoryReference(changed)] });
    expect(compiled.materialized).toBe(false);
    expectFast(compiled.sql);
    expect(compiled.sql).toContain(`${name === "COUNT" ? "COUNT_BIG" : name}(`);
    if (name === "SUM") expect(compiled.sql).toContain("DECIMAL(38, 10)");
    if (name === "AVG") expect(compiled.sql).toContain("AS FLOAT");
  });

  it.each(["COUNT(*)", "COUNT_BIG(*)"])("keeps %s as one aggregate including for an empty source", (expression) => {
    const compiled = compileQuery(withMeasure("Count rows", expression), { measures: ["Count rows"] });
    expect(compiled.materialized).toBe(false);
    expect(compiled.sql).toContain("COUNT_BIG(*) AS [m0]");
    expect(compiled.sql).not.toMatch(/GROUP BY|#df_|OVER\s*\(/);
  });

  it("keeps safe arithmetic, nested references, scalar functions and predicates on the fast path", () => {
    const expression = "IF([Profit] > 0 AND [Sales] <> 0, ROUND(ABS([Profit Margin %]), 2) + DIVIDE([Sales], [Quantity], 0), 0)";
    const compiled = compileQuery(withMeasure("Scalar ratio", expression), { measures: ["Sales", "Scalar ratio"], rows: [categoryReference(model)] });
    expectFast(compiled.sql);
    expect(compiled.sql).toMatch(/CASE WHEN[\s\S]*SUM/);
    expect(compiled.sql).toContain("ROUND(ABS(");
    expect(compiled.sql).toContain("NULLIF(");
  });

  it("preserves pivot metadata without introducing a ranking/window pass", () => {
    const refs = productCategoryReferences(model);
    const compiled = compileQuery(model, { measures: ["Sales", "Profit Margin %"], rows: [refs[0]], columns: [refs[1]] });
    expectFast(compiled.sql);
    expect(compiled.pivot).toEqual({ rowKeys: ["a0"], columnKeys: ["a1"], measureKeys: ["m0", "m1"] });
  });

  it.each(["Sales % of Total", "Furniture Sales", "Sales YTD", "Sales LY", "Sales YoY %", "Avg Order Value"])("retains materialization for context-sensitive %s", (measure) => {
    const compiled = compileQuery(model, { measures: ["Sales", measure], rows: [categoryReference(model)] });
    expect(compiled.materialized).toBe(true);
    expect(compiled.sql).toMatch(/INTO \[#df_base\]/);
    expect(compiled.sql).toContain(QUERY_PLAN_HINTS);
    expect(compiled.sql).not.toMatch(/^SET NOCOUNT ON;\s*DROP TABLE/);
    const catchSql = compiled.sql.slice(compiled.sql.indexOf("BEGIN CATCH"));
    expect(catchSql).toContain("DROP TABLE IF EXISTS [#df_base];");
  });

  it("snapshots the materialized context path with bounded query hints and guarded cleanup", () => {
    const compiled = compileQuery(model, { measures: ["Sales", "Sales % of Total"], rows: [categoryReference(model)] });
    expect(compiled.sql).toMatchSnapshot();
  });

  it("does not turn a constant-only ungrouped measure into one output row per fact", () => {
    const compiled = compileQuery(withMeasure("Constant", "1"), { measures: ["Constant"] });
    expect(compiled.materialized).toBe(true);
  });

  it("enforces the SQL Server parameter budget before returning the fast path", () => {
    const filters = Array.from({ length: 3 }, (_, index) => ({
      attribute: categoryReference(model),
      op: "in",
      values: Array.from({ length: 1000 }, (_, value) => `value-${index}-${value}`),
    }));
    expect(() => compileQuery(model, { measures: ["Sales"], rows: [categoryReference(model)], filters }))
      .toThrow(/too many parameter values/i);
  });
});

describe("bounded searched distinct-value compiler", () => {
  it("uses a single grouped SELECT with TOP 200 plus one truncation probe", () => {
    const compiled = compileDistinctValues(model, categoryReference(model));
    expectFast(compiled.sql);
    expect(compiled.limit).toBe(200);
    expect(compiled.params).toEqual([{ name: "__df_limit", value: 201, type: "number" }]);
    expect(compiled.sql).toMatchSnapshot();
  });

  it("parameterizes wildcard/bracket/escape characters as a literal substring search", () => {
    const search = "50%_[x]~' OR 1=1 --";
    const compiled = compileDistinctValues(model, categoryReference(model), true, { search, limit: 50 });
    expectFast(compiled.sql);
    expect(compiled.sql).toContain("LIKE @p0 ESCAPE N'~'");
    expect(compiled.sql).not.toContain(search);
    expect(compiled.params).toEqual([{ name: "p0", value: "%50~%~_~[x]~~' OR 1=1 --%", type: "string" }, { name: "__df_limit", value: 51, type: "number" }]);
  });

  it("searches calendar attributes by a stable string representation", () => {
    const table = model.tables.find((table) => table.id === model.date?.tableId)!;
    const date = table.columns.find((column) => column.id === model.date?.dateColumnId)!;
    const compiled = compileDistinctValues(model, { table: table.id, column: date.id }, true, { search: "2023-01" });
    expect(compiled.sql).toMatch(/CONVERT\(NVARCHAR\(4000\), \[d0\]\.\[Date\], 23\) LIKE @p0/);
    expect(compiled.params[0].value).toBe("%2023-01%");
  });

  it("validates search and count bounds", () => {
    for (const options of [{ limit: 201 }, { limit: 0 }, { limit: 1.5 }, { search: "x".repeat(201) }])
      expect(() => compileDistinctValues(model, categoryReference(model), true, options)).toThrow(QueryCompileError);
  });
});
