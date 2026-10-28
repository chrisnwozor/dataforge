import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearExpressionResolutionCache,
  createExpressionResolver,
  resolveExpression,
  type ResolvedExpr,
} from "@/lib/semantic/expr";
import * as parser from "@/lib/semantic/expr/parser";
import type { SemanticMeasure, SemanticModel } from "@/lib/semantic/types";

function measure(
  id: string,
  name: string,
  expression: string,
): SemanticMeasure {
  return {
    id,
    name,
    expression,
    format: "number",
    folder: "",
    description: "",
    isAuto: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function model(version = "same-version"): SemanticModel {
  return {
    projectId: "project",
    version,
    factTableId: "fact",
    relationships: [],
    hierarchies: [],
    tables: [
      {
        id: "fact",
        name: "fact_sales",
        sqlName: "fact_sales",
        schema: "dw",
        kind: "fact",
        keyColumnId: "key",
        columns: [
          {
            id: "key",
            tableId: "fact",
            name: "Key",
            sqlName: "fact_key",
            type: "number",
            role: "key",
          },
          {
            id: "sales-column",
            tableId: "fact",
            name: "Sales",
            sqlName: "sales",
            type: "number",
            role: "measure-source",
          },
          {
            id: "profit-column",
            tableId: "fact",
            name: "Profit",
            sqlName: "profit",
            type: "number",
            role: "measure-source",
          },
          {
            id: "order-column",
            tableId: "fact",
            name: "Order ID",
            sqlName: "order_id",
            type: "string",
            role: "attribute",
          },
        ],
      },
    ],
    measures: [
      measure("sales", "Sales", "SUM(fact_sales[Sales])"),
      measure("profit", "Profit", "SUM(fact_sales[Profit])"),
      measure(
        "orders",
        "Distinct Order ID",
        "DISTINCTCOUNT(fact_sales[Order ID])",
      ),
      measure("margin", "Profit Margin %", "DIVIDE([Profit], [Sales])"),
      measure("aov", "Avg Order Value", "DIVIDE([Sales], [Distinct Order ID])"),
    ],
  };
}
function call(node: ResolvedExpr) {
  if (node.kind !== "call") throw new Error("Expected a call AST.");
  return node;
}

beforeEach(() => {
  clearExpressionResolutionCache();
  vi.restoreAllMocks();
});

describe("shared expression expansion cache", () => {
  it("parses a base measure once and shares its immutable AST across ratios and fresh query models", () => {
    const parse = vi.spyOn(parser, "parse");
    const source = model();
    const resolver = createExpressionResolver(source);
    const sales = resolver.resolveMeasure("sales");
    const margin = resolver.resolveMeasure("margin");
    const aov = resolver.resolveMeasure("aov");
    const referencedSales = call(margin.ast).args[1];
    expect(referencedSales.kind).toBe("measure");
    if (referencedSales.kind !== "measure")
      throw new Error("Expected measure reference.");
    expect(referencedSales.expression).toBe(sales.ast);
    const aovSales = call(aov.ast).args[0];
    if (aovSales.kind !== "measure")
      throw new Error("Expected measure reference.");
    expect(aovSales.expression).toBe(sales.ast);
    expect(
      parse.mock.calls.filter(
        ([expression]) => expression === "SUM(fact_sales[Sales])",
      ),
    ).toHaveLength(1);
    const count = parse.mock.calls.length;
    expect(
      createExpressionResolver(structuredClone(source)).resolveMeasure("margin")
        .ast,
    ).toBe(margin.ast);
    expect(parse).toHaveBeenCalledTimes(count);
    expect(() => Object.assign(margin.ast, { type: "string" })).toThrow();
    expect(Object.isFrozen(call(margin.ast).args)).toBe(true);
  });

  it("returns complete transitive dependencies on a warm cache and protects them from caller edits", () => {
    const source = model();
    const first = resolveExpression(
      "[Profit Margin %] + [Avg Order Value]",
      source,
    );
    expect(new Set(first.dependencies)).toEqual(
      new Set(["margin", "profit", "sales", "aov", "orders"]),
    );
    first.dependencies.length = 0;
    const repeated = resolveExpression(
      "[Profit Margin %] + [Avg Order Value]",
      structuredClone(source),
    );
    expect(repeated.dependencies).toEqual([
      "margin",
      "profit",
      "sales",
      "aov",
      "orders",
    ]);
  });

  it("invalidates a namespace on a new version, changed expression, or metadata even if a caller reuses a version", () => {
    const source = model();
    const original = structuredClone(source);
    const first = createExpressionResolver(source).resolveMeasure("sales");
    const newer = { ...source, version: "new-version" };
    expect(
      createExpressionResolver(newer).resolveMeasure("sales").ast,
    ).not.toBe(first.ast);
    source.measures[0].expression = "1";
    expect(
      createExpressionResolver(source).resolveMeasure("sales").ast,
    ).toMatchObject({ kind: "literal", value: 1 });
    source.tables[0].columns[1].sqlName = "changed_name";
    // Cached references point at a frozen metadata snapshot, not the mutated caller.
    const argument = call(first.ast).args[0];
    if (argument.kind !== "column") throw new Error("Expected source column.");
    expect(argument.column.sqlName).toBe("sales");
    expect(createExpressionResolver(original).resolveMeasure("sales").ast).toBe(
      first.ast,
    );
  });

  it("does not hide a cycle introduced after an earlier valid expansion", () => {
    const source = model();
    createExpressionResolver(source).resolveMeasure("margin");
    source.measures[0].expression = "[Profit Margin %]";
    expect(() =>
      createExpressionResolver(source).resolveMeasure("margin"),
    ).toThrow("Profit Margin % → Sales → Profit Margin %");
  });

  it("enforces the transitive measure budget after referenced bodies have been cached", () => {
    const source = model();
    source.measures = Array.from({ length: 65 }, (_, index) =>
      measure(`m${index}`, `M${index}`, index === 64 ? "1" : `[M${index + 1}]`),
    );
    const resolver = createExpressionResolver(source);
    expect(resolver.resolve("[M1]").dependencies).toHaveLength(64);
    expect(() => resolver.resolve("[M0]")).toThrow("64 measures");
  });

  it("enforces expanded-node budgets on a reused DAG instead of treating cache hits as free", () => {
    const source = model();
    source.measures = Array.from({ length: 13 }, (_, index) =>
      measure(
        `m${index}`,
        `M${index}`,
        index === 12 ? "1" : `[M${index + 1}] + [M${index + 1}]`,
      ),
    );
    const resolver = createExpressionResolver(source);
    expect(resolver.resolveMeasure("m1").type).toBe("number");
    expect(() => resolver.resolveMeasure("m0")).toThrow("maximum 10,000 nodes");
  });

  it("bounds retained model versions and evicts the least recently used namespace", () => {
    const firstModel = model("v0");
    const first = createExpressionResolver(firstModel).resolveMeasure("sales");
    for (let index = 1; index <= 8; index++)
      createExpressionResolver(model(`v${index}`)).resolveMeasure("sales");
    expect(
      createExpressionResolver(firstModel).resolveMeasure("sales").ast,
    ).not.toBe(first.ast);
  });

  it("keeps memoization request-local for models too large for persistent caching", () => {
    const source = model();
    source.measures.push(
      ...Array.from({ length: 300 }, (_, index) => ({
        ...measure(`large-${index}`, `Large ${index}`, "1"),
        description: "x".repeat(2_000),
      })),
    );
    const resolver = createExpressionResolver(source);
    const first = resolver.resolveMeasure("sales");
    expect(resolver.resolveMeasure("sales").ast).toBe(first.ast);
    expect(
      createExpressionResolver(structuredClone(source)).resolveMeasure("sales")
        .ast,
    ).not.toBe(first.ast);
  });
});
