import { beforeAll, describe, expect, it } from "vitest";
import type { SemanticMeasure, SemanticModel } from "@/lib/semantic/types";
import { compileQuery } from "@/lib/semantic/query/compile";
import { createSuperstoreSemanticFixture } from "./fixtures/superstore-semantic";
import {
  expectedSuperstoreResults,
  readSuperstoreRows,
  previousYear,
  type SuperstoreAxis,
} from "./fixtures/superstore-results";
import { createSuperstoreWarehouse } from "./helpers/superstore-warehouse";
import { executeMaterializedSqlite } from "./helpers/materialized-sqlite";
import { assertFastShape, assertMaterializedShape } from "./helpers/materialized-shape";

const names = [
  "Sales",
  "Profit Margin %",
  "Avg Order Value",
  "Sales % of Total",
  "Sales % of Category",
  "Sales % of Grand Total",
  "Sales % of All Years",
  "Sales % of Calendar Grand Total",
  "Sales YTD",
  "Sales LY",
  "Sales YoY %",
];
let model: SemanticModel;
const observations = readSuperstoreRows();
beforeAll(async () => {
  model = await createSuperstoreSemanticFixture();
  const add = (name: string, expression: string): SemanticMeasure => ({
    ...model.measures[0],
    id: `calendar:${name}`,
    name,
    expression,
    isAuto: false,
  });
  model = {
    ...model,
    version: `${model.version}:calendar-results`,
    measures: [
      ...model.measures,
      add(
        "Sales % of All Years",
        "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_date[Year])))",
      ),
      add(
        "Sales % of Calendar Grand Total",
        "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_date[Year]), ALL(dim_date[Month])))",
      ),
    ],
  };
});

const axesCases: SuperstoreAxis[][] = [
  ["Year"],
  ["Month"],
  ["Year", "Month"],
  ["Product", "Category"],
];

describe("Superstore simple-query and materialized-query equivalence", () => {
  it.each([[], ...axesCases].map((axes) => [axes.join(" + ") || "grand total", axes] as const))(
    "preserves every aggregate and ratio by %s",
    (_name, axes) => {
      const definitions = [
        ["Sum", "SUM(fact_sales[Sales])"],
        ["Average", "AVG(fact_sales[Sales])"],
        ["Minimum", "MIN(fact_sales[Sales])"],
        ["Maximum", "MAX(fact_sales[Sales])"],
        ["Non-null count", "COUNT(fact_sales[Sales])"],
        ["Row count", "COUNT_BIG(*)"],
        ["Margin", "DIVIDE(SUM(fact_sales[Profit]), SUM(fact_sales[Sales]))"],
        ["Sales per quantity", "DIVIDE(SUM(fact_sales[Sales]), SUM(fact_sales[Quantity]))"],
      ];
      const testMeasures = definitions.map(([name, expression], index) => ({
        ...model.measures[0], id: `equivalence:${index}`, name: `Equivalence ${name}`, expression, isAuto: false,
      }));
      const fastModel: SemanticModel = { ...model, version: `${model.version}:fast-equivalence`, measures: testMeasures };
      const materializedModel: SemanticModel = {
        ...fastModel,
        version: `${model.version}:materialized-equivalence`,
        measures: testMeasures.map((measure) => ({
          ...measure,
          // This column is neither grouped nor filtered, so removing its
          // context changes no values while deliberately choosing the old path.
          expression: `CALCULATE(${measure.expression}, ALL(fact_sales[Order ID]))`,
        })),
      };
      const rows = axes.map((name) => {
        const table = model.tables.find((table) => table.columns.some((column) => column.name === name))!;
        return { table: table.id, column: table.columns.find((column) => column.name === name)!.id };
      });
      const input = { measures: testMeasures.map((measure) => measure.id), rows };
      const fast = compileQuery(fastModel, input);
      const materialized = compileQuery(materializedModel, input);
      assertFastShape(fast.sql, rows.length > 0);
      assertMaterializedShape(materialized.sql);
      const db = createSuperstoreWarehouse(model, observations);
      try {
        const actual = executeMaterializedSqlite(db, fast);
        const expected = executeMaterializedSqlite(db, materialized);
        expect(actual).toHaveLength(expected.length);
        expect(fast.columns).toEqual(materialized.columns);
        for (const [index, record] of actual.entries()) {
          for (const column of fast.columns) {
            const value = record[column.key];
            const reference = expected[index][column.key];
            if (column.role === "measure" && reference !== null)
              expect(Number(value), `${column.name} at ${index}`).toBeCloseTo(Number(reference), 5);
            else expect(value, `${column.name} at ${index}`).toEqual(reference);
          }
        }
      } finally { db.close(); }
    },
  );
});

describe("materialized Superstore numeric results", () => {
  it.each(axesCases.map((axes) => [axes.join(" + "), axes] as const))(
    "keeps measures and time intelligence unchanged by %s",
    (_name, axes) => {
      const rows = axes.map((name) => {
        const table = model.tables.find((table) =>
          table.columns.some((column) => column.name === name),
        )!;
        return {
          table: table.id,
          column: table.columns.find((column) => column.name === name)!.id,
        };
      });
      const compiled = compileQuery(model, { measures: names, rows });
      const db = createSuperstoreWarehouse(model, observations);
      try {
        const actual = executeMaterializedSqlite(db, compiled).map((row) =>
          Object.fromEntries(
            compiled.columns.map((column) => [
              column.name,
              row[column.key] as string | number | null,
            ]),
          ),
        );
        const expected = expectedSuperstoreResults(observations, axes);
        expect(actual).toHaveLength(expected.length);
        const observed = new Map(
          actual.map((row) => [
            JSON.stringify(axes.map((axis) => row[axis])),
            row,
          ]),
        );
        for (const row of expected) {
          const found = observed.get(
            JSON.stringify(axes.map((axis) => row[axis])),
          )!;
          expect(
            found,
            `Missing ${JSON.stringify(axes.map((axis) => row[axis]))}`,
          ).toBeDefined();
          for (const name of names) {
            if (row[name] === null) expect(found[name], name).toBeNull();
            else
              expect(Number(found[name]), name).toBeCloseTo(
                Number(row[name]),
                5,
              );
          }
        }
        // Round the independently checked outputs so snapshots document stable
        // numeric behavior without binding tests to floating point display noise.
        const snapshot = expected.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              key,
              typeof value === "number" ? Math.round(value * 1e6) / 1e6 : value,
            ]),
          ),
        );
        expect(snapshot).toMatchSnapshot();
      } finally {
        db.close();
      }
    },
  );
});

describe("exact distinct time periods", () => {
  it.each([
    { axes: ["Year"] as SuperstoreAxis[] },
    { axes: ["Year", "Month"] as SuperstoreAxis[] },
  ])("counts repeated orders once in YTD and LY by $axes", ({ axes }) => {
    const facts = [
      ["2024-01-01", "A"],
      ["2024-02-01", "A"],
      ["2024-02-02", "B"],
      ["2025-01-01", "A"],
      ["2025-02-01", "C"],
      ["2025-02-02", "C"],
      ["2025-02-03", "D"],
    ].map(([date, orderId], index) => {
      const base = observations[index];
      const raw = [...base.raw];
      raw[0] = orderId;
      raw[1] = date;
      return {
        ...base,
        date,
        orderId,
        year: Number(date.slice(0, 4)),
        month: Number(date.slice(5, 7)),
        raw,
      };
    });
    const custom = (name: string, expression: string): SemanticMeasure => ({
      ...model.measures[0],
      id: `distinct-time:${name}`,
      name,
      expression,
      isAuto: false,
    });
    const exact = {
      ...model,
      version: `${model.version}:distinct-time`,
      measures: [
        ...model.measures,
        custom("Orders YTD", "YTD([Distinct Order ID])"),
        custom("Orders LY", "SAMEPERIODLASTYEAR([Distinct Order ID])"),
      ],
    };
    const rows = axes.map((name) => {
      const table = exact.tables.find((table) =>
        table.columns.some((column) => column.name === name),
      )!;
      return {
        table: table.id,
        column: table.columns.find((column) => column.name === name)!.id,
      };
    });
    const compiled = compileQuery(exact, {
      measures: ["Orders YTD", "Orders LY"],
      rows,
    });
    const db = createSuperstoreWarehouse(exact, facts);
    try {
      const actual = executeMaterializedSqlite(db, compiled).map((row) =>
        Object.fromEntries(
          compiled.columns.map((column) => [column.name, row[column.key]]),
        ),
      );
      for (const result of actual) {
        const current = facts.filter(
          (row) =>
            row.year === Number(result.Year) &&
            (!axes.includes("Month") || row.month === Number(result.Month)),
        );
        const dates = current.map((row) => row.date).sort(),
          end = dates.at(-1)!;
        const ytd = facts.filter(
          (row) => row.date >= `${end.slice(0, 4)}-01-01` && row.date <= end,
        );
        const lower = previousYear(dates[0]),
          upper = previousYear(end);
        const ly = facts.filter(
          (row) => row.date >= lower && row.date <= upper,
        );
        expect(Number(result["Orders YTD"])).toBe(
          new Set(ytd.map((row) => row.orderId)).size,
        );
        expect(Number(result["Orders LY"])).toBe(
          new Set(ly.map((row) => row.orderId)).size,
        );
      }
    } finally {
      db.close();
    }
  });
});
