import { beforeAll, describe, expect, it } from "vitest";
import { compileQuery } from "@/lib/semantic/query/compile";
import { semanticQuerySchema } from "@/lib/semantic/query/schema";
import { assertFastShape, assertMaterializedShape } from "./helpers/materialized-shape";
import type { SemanticModel } from "@/lib/semantic/types";
import {
  categoryReference,
  createSuperstoreSemanticFixture,
  performanceMeasureSets,
  productCategoryReferences,
} from "./fixtures/superstore-semantic";

let model: SemanticModel;
beforeAll(async () => {
  // Profiling the 2,000 input rows and deriving metadata are not part of these
  // pure compiler benchmarks. No connection, SQL Server, or result cache is used.
  model = await createSuperstoreSemanticFixture();
});

const names = [
  "Sales",
  "Sales + Profit Margin %",
  "Sales + Profit Margin % + Avg Order Value",
  "Sales + Profit Margin % + Avg Order Value + Sales % of Total",
  "Sales + Profit Margin % + Avg Order Value + Sales % of Total + Furniture Sales",
  "all measures",
];
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Count expanded source paths rather than just occurrences of the physical
 * table name. SQL Server CTEs are not materialized: referencing a raw-data CTE
 * from ten correlated subqueries still creates ten possible fact reads.
 * These generated queries contain bracketed identifiers and parameterized
 * literals, so tokenizing identifiers/parentheses is sufficient for this guard.
 */
function queryParts(sql: string) {
  const tokens = [
    ...sql.matchAll(/\[(?:[^\]]|\]\])*\]|[A-Za-z_][A-Za-z_0-9]*|[(),.]/g),
  ].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const unquote = (value: string) =>
    value.startsWith("[") ? value.slice(1, -1).replaceAll("]]", "]") : value;
  const ctes = new Map<string, string>();
  let cursor = 0;
  if (tokens[0]?.value.toUpperCase() === "WITH") {
    cursor++;
    do {
      const name = unquote(tokens[cursor++].value);
      expect(tokens[cursor++].value.toUpperCase()).toBe("AS");
      expect(tokens[cursor].value).toBe("(");
      const start = tokens[cursor++].end;
      let depth = 1;
      while (depth && cursor < tokens.length) {
        if (tokens[cursor].value === "(") depth++;
        if (tokens[cursor].value === ")") depth--;
        cursor++;
      }
      expect(depth).toBe(0);
      ctes.set(name, sql.slice(start, tokens[cursor - 1].start));
      if (tokens[cursor]?.value !== ",") break;
      cursor++;
    } while (cursor < tokens.length);
  }
  return { ctes, select: sql.slice(tokens[cursor]?.start ?? 0) };
}

function expandedFactSources(sql: string): number {
  const { ctes, select } = queryParts(sql);
  function reads(text: string, visiting = new Set<string>()): number {
    let count = 0;
    for (const match of text.matchAll(
      /\b(?:FROM|JOIN)\s+\[([^\]]+)\](?:\s*\.\s*\[([^\]]+)\])?/gi,
    )) {
      if (match[2]) {
        if (match[1] === "dw" && match[2] === "fact_sales") count++;
      } else if (ctes.has(match[1])) {
        expect(
          visiting.has(match[1]),
          "The generated CTE graph must be acyclic",
        ).toBe(false);
        count += reads(ctes.get(match[1])!, new Set([...visiting, match[1]]));
      }
    }
    return count;
  }
  return reads(select);
}

function aggregateCalls(sql: string) {
  return {
    sums: [...sql.matchAll(/\bSUM\s*\(/g)].length,
    distinctCounts: [...sql.matchAll(/\bCOUNT_BIG\s*\(\s*DISTINCT/g)].length,
  };
}

describe("Superstore compiler performance", () => {
  it("accepts the complete 33-measure model while keeping the request capped at 64", () => {
    expect(model.measures).toHaveLength(33);
    expect(
      semanticQuerySchema.safeParse({
        measures: model.measures.map((measure) => measure.id),
      }).success,
    ).toBe(true);
    expect(
      semanticQuerySchema.safeParse({
        measures: Array.from({ length: 64 }, (_, index) => `measure:${index}`),
      }).success,
    ).toBe(true);
    expect(
      semanticQuerySchema.safeParse({
        measures: Array.from({ length: 65 }, (_, index) => `measure:${index}`),
      }).success,
    ).toBe(false);
  });
  it.each(names)("compiles %s within its cold and warm CPU budgets", (name) => {
    const set = performanceMeasureSets(model).find((set) => set.name === name)!;
    if (name === "all measures")
      expect(set.measures.length).toBeGreaterThanOrEqual(30);
    const input = { measures: set.measures, rows: [categoryReference(model)] };
    const cold: number[] = [];
    const warm: number[] = [];
    // Independent versions exercise cold expansion; repeated calls exercise the
    // memoized path. Medians exclude scheduler/GC outliers, not compiler work.
    for (let repeat = 0; repeat < 7; repeat++) {
      const uncachedModel = {
        ...model,
        version: `${model.version}:${name}:${repeat}`,
      };
      const start = performance.now();
      const compiled = compileQuery(uncachedModel, input);
      cold.push(performance.now() - start);
      expect(
        compiled.columns.filter((column) => column.role === "measure"),
      ).toHaveLength(set.measures.length);
    }
    compileQuery(model, input);
    for (let repeat = 0; repeat < 7; repeat++) {
      const start = performance.now();
      compileQuery(model, input);
      warm.push(performance.now() - start);
    }
    expect(median(cold), `${name}: cold compile milliseconds`).toBeLessThan(
      set.budgetMs,
    );
    expect(median(warm), `${name}: warm compile milliseconds`).toBeLessThan(
      set.budgetMs,
    );
  });

  it.each(names.slice(0, -1))(
    "keeps one fact source for %s, including expanded CTE references",
    (name) => {
      const set = performanceMeasureSets(model).find(
        (set) => set.name === name,
      )!;
      const compiled = compileQuery(model, {
        measures: set.measures,
        rows: [categoryReference(model)],
      });
      expect(expandedFactSources(compiled.sql)).toBe(1);
      if (name === "Sales" || name === "Sales + Profit Margin %") {
        expect(compiled.materialized).not.toBe(true);
        assertFastShape(compiled.sql);
      } else assertMaterializedShape(compiled.sql);
    },
  );

  it("aggregates referenced base measures once, then computes ratios from the aggregate columns", () => {
    const rows = [categoryReference(model)];
    const base = compileQuery(model, {
      measures: ["Sales", "Profit", "Distinct Order ID"],
      rows,
    });
    const derived = compileQuery(model, {
      measures: [
        "Sales",
        "Profit",
        "Distinct Order ID",
        "Profit Margin %",
        "Avg Order Value",
        "Rounded Margin %",
        "Positive Margin %",
      ],
      rows,
    });
    expect(aggregateCalls(base.sql)).toEqual({ sums: 2, distinctCounts: 1 });
    expect(aggregateCalls(derived.sql)).toEqual(aggregateCalls(base.sql));
    expect(expandedFactSources(derived.sql)).toBe(1);
    assertMaterializedShape(derived.sql);
    // Ratio/rounding/IF work belongs outside the aggregation, not inside a
    // second SELECT reading the fact or the raw-data CTE for each reference.
    const outputStart = derived.sql.lastIndexOf(
      "SELECT ",
      derived.sql.indexOf("INTO [#df_result]"),
    );
    const output = derived.sql.slice(
      outputStart,
      derived.sql.indexOf("INTO [#df_result]"),
    );
    const parts = queryParts(output);
    const marginKey = derived.columns.find(
      (column) => column.name === "Profit Margin %",
    )!.key;
    const projection = [...parts.ctes.values(), parts.select].find((body) =>
      body.includes(`AS [${marginKey}]`),
    );
    expect(
      projection,
      "The derived ratio must have an outer projection",
    ).toBeDefined();
    expect(projection).not.toMatch(/\b(?:SUM|AVG|MIN|MAX|COUNT_BIG)\s*\(/);
  });

  it("compiles the reported Product + Category shares under 50 ms with one fact aggregation", () => {
    const input = {
      measures: ["Sales", "Sales % of Category", "Sales % of Grand Total"],
      rows: productCategoryReferences(model),
    };
    const samples = Array.from({ length: 7 }, () => {
      const start = performance.now();
      compileQuery(model, input);
      return performance.now() - start;
    });
    expect(median(samples)).toBeLessThan(50);
    const compiled = compileQuery(model, input);
    expect(expandedFactSources(compiled.sql)).toBe(1);
    assertMaterializedShape(compiled.sql);
    // One base SUM, plus two window SUMs over that shared aggregate: category
    // and grand totals must not introduce correlated raw-table reads.
    expect(aggregateCalls(compiled.sql)).toEqual({
      sums: 3,
      distinctCounts: 0,
    });
    expect([
      ...compiled.sql.matchAll(/\bSUM\([^)]*\)\s+OVER\s*\(/g),
    ]).toHaveLength(2);
  });
});

describe("simple and materialized time-query plan shape", () => {
  const cases = [
    ["Sales", ["Year"]],
    ["Sales YTD", ["Year"]],
    ["Sales LY", ["Year"]],
    ["Sales YoY %", ["Year"]],
    ["Sales YoY %", ["Year", "Month"]],
    ["Sales % of All Years", ["Year"]],
  ] as const;
  it.each(cases)("bounds the batch shape for %s by %j", (measure, axes) => {
    const semantic: SemanticModel = {
      ...model,
      version: `${model.version}:time-shape`,
      measures: [
        ...model.measures,
        {
          ...model.measures[0],
          id: "shape:all-years",
          name: "Sales % of All Years",
          expression:
            "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_date[Year])))",
          isAuto: false,
        },
      ],
    };
    const rows = axes.map((name) => {
      const table = semantic.tables.find((table) =>
        table.columns.some((column) => column.name === name),
      )!;
      return {
        table: table.id,
        column: table.columns.find((column) => column.name === name)!.id,
      };
    });
    const compiled = compileQuery(semantic, { measures: [measure], rows });
    if (measure === "Sales") assertFastShape(compiled.sql);
    else {
      assertMaterializedShape(compiled.sql);
      expect(compiled.sql.match(/GROUP BY GROUPING SETS/g)).toHaveLength(1);
    }
    expect(compiled.sql).not.toContain("__df_scalar_");
  });
});
