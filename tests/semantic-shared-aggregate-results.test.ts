import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { compileQuery } from "@/lib/semantic/query/compile";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
} from "@/lib/semantic/types";
import type { AttributeRef, QueryValue } from "@/lib/semantic/query/types";

const productRows = [
  { id: -1, category: "Unknown", product: "Unknown" },
  { id: 1, category: "Furniture", product: "Chair" },
  { id: 2, category: "Furniture", product: "Desk" },
  { id: 3, category: "Office", product: "Pen" },
  { id: 4, category: "Office", product: "Paper" },
  { id: 5, category: "Technology", product: "Monitor" },
  { id: 6, category: null, product: "Cable" },
] as const;
const regionRows = [
  { id: 1, region: "East" },
  { id: 2, region: "West" },
  { id: 3, region: "Central" },
] as const;
const source = [
  { product: 1, region: 1, sales: 100, profit: 20, order: "A" },
  { product: 2, region: 1, sales: 200, profit: 40, order: "A" },
  { product: 1, region: 2, sales: 50, profit: -5, order: "B" },
  { product: 3, region: 1, sales: 80, profit: 8, order: "B" },
  { product: 4, region: 2, sales: 20, profit: 2, order: "C" },
  { product: 5, region: 1, sales: 300, profit: 90, order: "D" },
  { product: 5, region: 2, sales: 150, profit: 30, order: "E" },
  { product: 6, region: 1, sales: 40, profit: null, order: "F" },
  { product: 6, region: 2, sales: null, profit: null, order: "G" },
  { product: -1, region: 1, sales: 999, profit: 999, order: "UNKNOWN" },
  { product: 2, region: 2, sales: null, profit: -1, order: null },
  { product: 3, region: 3, sales: 0, profit: 0, order: "H" },
  { product: 4, region: 3, sales: null, profit: 5, order: "H" },
  { product: 6, region: 3, sales: null, profit: null, order: null },
];
type Observation = (typeof source)[number];
const visibleSource = source.filter((row) => row.product !== -1);
const categoryOf = (row: Observation) =>
  productRows.find((product) => product.id === row.product)!.category;
const productOf = (row: Observation) =>
  productRows.find((product) => product.id === row.product)!.product;
const regionOf = (row: Observation) =>
  regionRows.find((region) => region.id === row.region)!.region;
const sum = (rows: Observation[], field: "sales" | "profit") => {
  const values = rows
    .map((row) => row[field])
    .filter((value) => value !== null);
  return values.length
    ? values.reduce((total, value) => total + value, 0)
    : null;
};
const distinctOrders = (rows: Observation[]) =>
  new Set(rows.map((row) => row.order).filter((value) => value !== null)).size;
const divide = (a: number | null, b: number | null) =>
  a === null || b === null || b === 0 ? null : a / b;

const column = (
  tableId: string,
  id: string,
  name: string,
  sqlName: string,
  type: SemanticColumn["type"],
  role: SemanticColumn["role"] = "attribute",
): SemanticColumn => ({ tableId, id, name, sqlName, type, role });
const fact: SemanticTable = {
  id: "fact",
  name: "fact_sales",
  sqlName: "fact_sales",
  schema: "dw",
  kind: "fact",
  keyColumnId: "f:key",
  columns: [
    column("fact", "f:key", "Fact key", "fact_key", "number", "key"),
    column("fact", "f:sales", "Sales", "sales", "number", "measure-source"),
    column("fact", "f:profit", "Profit", "profit", "number", "measure-source"),
    column("fact", "f:order", "Order ID", "order_id", "string"),
    column("fact", "f:product", "Product key", "product_key", "number", "key"),
    column("fact", "f:region", "Region key", "region_key", "number", "key"),
  ],
};
const product: SemanticTable = {
  id: "product",
  name: "dim_product",
  sqlName: "dim_product",
  schema: "dw",
  kind: "dimension",
  keyColumnId: "p:key",
  columns: [
    column("product", "p:key", "Product key", "product_key", "number", "key"),
    column("product", "p:category", "Category", "category", "string"),
    column("product", "p:name", "Product", "product", "string"),
  ],
};
const region: SemanticTable = {
  id: "region",
  name: "dim_region",
  sqlName: "dim_region",
  schema: "dw",
  kind: "dimension",
  keyColumnId: "r:key",
  columns: [
    column("region", "r:key", "Region key", "region_key", "number", "key"),
    column("region", "r:name", "Region", "region", "string"),
  ],
};
const category: AttributeRef = { table: product.id, column: "p:category" };
const productName: AttributeRef = { table: product.id, column: "p:name" };
const regionName: AttributeRef = { table: region.id, column: "r:name" };
const definitions = [
  ["Sales", "SUM(fact_sales[Sales])"],
  ["Profit", "SUM(fact_sales[Profit])"],
  ["Row Count", "COUNT_BIG(*)"],
  ["Distinct Order ID", "DISTINCTCOUNT(fact_sales[Order ID])"],
  ["Avg Sales", "AVG(fact_sales[Sales])"],
  ["Profit Margin %", "DIVIDE([Profit], [Sales])"],
  ["Avg Order Value", "DIVIDE([Sales], [Distinct Order ID])"],
  [
    "Sales % of Total",
    "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[Category])))",
  ],
  [
    "Furniture Sales",
    "CALCULATE([Sales], dim_product[Category] = 'Furniture')",
  ],
  ["All Orders", "CALCULATE([Distinct Order ID], ALL(dim_product[Category]))"],
  ["Global Avg Sales", "CALCULATE([Avg Sales], ALL(dim_product[Category]))"],
  [
    "Nested Furniture",
    "CALCULATE(CALCULATE([Sales], dim_product[Category] = 'Furniture'), dim_product[Category] = 'Office')",
  ],
  [
    "Nested All",
    "CALCULATE(CALCULATE([Sales], ALL(dim_product[Category])), dim_product[Category] = 'Furniture')",
  ],
] as const;
const model: SemanticModel = {
  projectId: "test-project",
  version: "shared-oracle-1",
  factTableId: fact.id,
  tables: [fact, product, region],
  hierarchies: [],
  relationships: [
    {
      id: "product-link",
      fromTableId: fact.id,
      fromColumnId: "f:product",
      toTableId: product.id,
      toColumnId: "p:key",
      cardinality: "many-to-one",
    },
    {
      id: "region-link",
      fromTableId: fact.id,
      fromColumnId: "f:region",
      toTableId: region.id,
      toColumnId: "r:key",
      cardinality: "many-to-one",
    },
  ],
  measures: definitions.map(([name, expression], index): SemanticMeasure => ({
    id: `m${index}`,
    name,
    expression,
    format: "number",
    folder: "",
    description: "",
    isAuto: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
};

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS [dw];
    CREATE TABLE [dw].[fact_sales] ([fact_key] INTEGER PRIMARY KEY, [product_key] INTEGER, [region_key] INTEGER, [sales] REAL, [profit] REAL, [order_id] TEXT);
    CREATE TABLE [dw].[dim_product] ([product_key] INTEGER PRIMARY KEY, [category] TEXT, [product] TEXT);
    CREATE TABLE [dw].[dim_region] ([region_key] INTEGER PRIMARY KEY, [region] TEXT);`);
  const insertProduct = db.prepare(
    "INSERT INTO [dw].[dim_product] VALUES (?, ?, ?)",
  );
  for (const row of productRows)
    insertProduct.run(row.id, row.category, row.product);
  const insertRegion = db.prepare(
    "INSERT INTO [dw].[dim_region] VALUES (?, ?)",
  );
  for (const row of regionRows) insertRegion.run(row.id, row.region);
  const insertFact = db.prepare(
    "INSERT INTO [dw].[fact_sales] VALUES (?, ?, ?, ?, ?, ?)",
  );
  source.forEach((row, index) =>
    insertFact.run(
      index + 1,
      row.product,
      row.region,
      row.sales,
      row.profit,
      row.order,
    ),
  );
});
afterEach(() => db.close());

/**
 * A relational oracle, not a SQL Server integration or execution-plan test.
 * These numeric/null queries use the SQL common to both engines; only COUNT_BIG
 * and the final parameterized TOP are translated. Date functions are excluded.
 */
function execute(input: unknown, semanticModel = model) {
  const compiled = compileQuery(semanticModel, input);
  const sql = compiled.sql
    .replace(/\bCOUNT_BIG\s*\(/g, "COUNT(")
    .replace(/SELECT TOP \(@__df_limit\)/, "SELECT")
    .replace(/;\s*$/, "\nLIMIT @__df_limit;");
  const params = Object.fromEntries(
    compiled.params.map((param) => [
      `@${param.name}`,
      typeof param.value === "boolean" ? Number(param.value) : param.value,
    ]),
  );
  const rows = db
    .prepare(sql)
    .all(params)
    .map((row) =>
      Object.fromEntries(
        compiled.columns.map((col) => [col.name, row[col.key] as QueryValue]),
      ),
    );
  return rows;
}
function close(actual: QueryValue | undefined, expected: number | null) {
  if (expected === null) expect(actual).toBeNull();
  else expect(Number(actual)).toBeCloseTo(expected, 9);
}

describe("shared aggregates retain relational results", () => {
  const cumulative = [
    "Sales",
    "Profit Margin %",
    "Avg Order Value",
    "Sales % of Total",
    "Furniture Sales",
  ];
  it.each(cumulative)(
    "keeps expected category values through the cumulative set ending with %s",
    (name) => {
      const measures = cumulative.slice(0, cumulative.indexOf(name) + 1);
      const rows = execute({ measures, rows: [category] });
      const categories = [...new Set(visibleSource.map(categoryOf))];
      expect(rows).toHaveLength(categories.length);
      for (const value of categories) {
        const observations = visibleSource.filter(
          (row) => categoryOf(row) === value,
        );
        const actual = rows.find((row) => row.Category === value)!;
        close(actual.Sales, sum(observations, "sales"));
        if (measures.includes("Profit Margin %"))
          close(
            actual["Profit Margin %"],
            divide(sum(observations, "profit"), sum(observations, "sales")),
          );
        if (measures.includes("Avg Order Value"))
          close(
            actual["Avg Order Value"],
            divide(sum(observations, "sales"), distinctOrders(observations)),
          );
        if (measures.includes("Sales % of Total"))
          close(
            actual["Sales % of Total"],
            divide(sum(observations, "sales"), sum(visibleSource, "sales")),
          );
        if (measures.includes("Furniture Sales"))
          close(
            actual["Furniture Sales"],
            sum(
              visibleSource.filter((row) => categoryOf(row) === "Furniture"),
              "sales",
            ),
          );
      }
    },
  );

  it("computes ALL totals before hiding rows excluded by Category slicers", () => {
    const rows = execute({
      measures: cumulative,
      rows: [category],
      filters: [{ attribute: category, op: "eq", value: "Furniture" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].Category).toBe("Furniture");
    close(rows[0].Sales, 350);
    close(rows[0]["Sales % of Total"], 350 / 940);
  });

  it("preserves Region filters and grouping when ALL removes Category", () => {
    const rows = execute({
      measures: ["Sales", "Sales % of Total", "Furniture Sales"],
      rows: [category, regionName],
    });
    expect(rows).toHaveLength(
      new Set(
        visibleSource.map((row) =>
          JSON.stringify([categoryOf(row), regionOf(row)]),
        ),
      ).size,
    );
    for (const actual of rows) {
      const scoped = visibleSource.filter(
        (row) => regionOf(row) === actual.Region,
      );
      const cell = scoped.filter((row) => categoryOf(row) === actual.Category);
      close(actual.Sales, sum(cell, "sales"));
      close(
        actual["Sales % of Total"],
        divide(sum(cell, "sales"), sum(scoped, "sales")),
      );
      close(
        actual["Furniture Sales"],
        sum(
          scoped.filter((row) => categoryOf(row) === "Furniture"),
          "sales",
        ),
      );
    }
    const east = execute({
      measures: ["Sales", "Sales % of Total"],
      rows: [category],
      filters: [
        { attribute: category, op: "eq", value: "Furniture" },
        { attribute: regionName, op: "eq", value: "East" },
      ],
    });
    expect(east).toHaveLength(1);
    close(east[0].Sales, 300);
    close(east[0]["Sales % of Total"], 300 / 720);
  });

  it("preserves Product grouping and real NULL Category members", () => {
    const rows = execute({
      measures: ["Sales", "Sales % of Total"],
      rows: [category, productName],
    });
    expect(rows).toHaveLength(new Set(visibleSource.map(productOf)).size);
    for (const actual of rows) {
      const scoped = visibleSource.filter(
        (row) => productOf(row) === actual.Product,
      );
      close(actual.Sales, sum(scoped, "sales"));
      close(
        actual["Sales % of Total"],
        divide(sum(scoped, "sales"), sum(scoped, "sales")),
      );
    }
    const nullCategory = rows.find((row) => row.Category === null)!;
    expect(nullCategory.Product).toBe("Cable");
    close(nullCategory.Sales, 40);
  });

  it("does not add distinct counts or average group averages when grouping is removed", () => {
    const rows = execute({
      measures: [
        "Distinct Order ID",
        "All Orders",
        "Avg Sales",
        "Global Avg Sales",
      ],
      rows: [category, regionName],
    });
    expect(rows).toHaveLength(
      new Set(
        visibleSource.map((row) =>
          JSON.stringify([categoryOf(row), regionOf(row)]),
        ),
      ).size,
    );
    for (const actual of rows) {
      const scoped = visibleSource.filter(
        (row) => regionOf(row) === actual.Region,
      );
      const cell = scoped.filter((row) => categoryOf(row) === actual.Category);
      close(actual["Distinct Order ID"], distinctOrders(cell));
      close(actual["All Orders"], distinctOrders(scoped));
      close(
        actual["Avg Sales"],
        divide(
          sum(cell, "sales"),
          cell.filter((row) => row.sales !== null).length,
        ),
      );
      close(
        actual["Global Avg Sales"],
        divide(
          sum(scoped, "sales"),
          scoped.filter((row) => row.sales !== null).length,
        ),
      );
    }
  });

  it("applies inner CALCULATE replacements and ALL without retaining outer filters", () => {
    const rows = execute({
      measures: ["Nested Furniture", "Nested All"],
      rows: [category],
    });
    expect(rows).toHaveLength(new Set(visibleSource.map(categoryOf)).size);
    for (const actual of rows) {
      close(actual["Nested Furniture"], 350);
      close(actual["Nested All"], 940);
    }
  });

  it("keeps derived scalar contexts correct when non-additive totals require the fallback plan", () => {
    const rows = execute({
      measures: [...cumulative, "Global Avg Sales", "All Orders"],
      rows: [category],
      filters: [{ attribute: category, op: "eq", value: "Furniture" }],
    });
    expect(rows).toHaveLength(1);
    close(rows[0].Sales, 350);
    close(rows[0]["Profit Margin %"], 54 / 350);
    close(rows[0]["Avg Order Value"], 175);
    close(rows[0]["Sales % of Total"], 350 / 940);
    close(rows[0]["Furniture Sales"], 350);
    close(rows[0]["All Orders"], 8);
    close(rows[0]["Global Avg Sales"], 940 / 9);
  });

  it("returns COUNT zero and SUM/ratios null on an empty ungrouped fact", () => {
    db.exec("DELETE FROM [dw].[fact_sales]");
    const rows = execute({
      measures: [
        "Sales",
        "Row Count",
        "Distinct Order ID",
        "Profit Margin %",
        "Avg Order Value",
      ],
      rows: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      Sales: null,
      "Row Count": 0,
      "Distinct Order ID": 0,
      "Profit Margin %": null,
      "Avg Order Value": null,
    });
    expect(
      execute({ measures: ["Sales", "Sales % of Total"], rows: [category] }),
    ).toEqual([]);
  });

  it("computes the exact Product/Category share query over 2,000 Superstore rows in under one second locally", () => {
    // Fixture parsing/loading is outside the timed query. This is a relational
    // regression, not a claim about SQL Server's execution plan or latency.
    const observations = parse(
      readFileSync(join(process.cwd(), "samples/superstore_sales.csv")),
      { columns: true },
    ) as Record<string, string>[];
    expect(observations).toHaveLength(2_000);
    db.exec("DELETE FROM [dw].[fact_sales]; DELETE FROM [dw].[dim_product]");
    const insertProduct = db.prepare(
      "INSERT INTO [dw].[dim_product] VALUES (?, ?, ?)",
    );
    const insertFact = db.prepare(
      "INSERT INTO [dw].[fact_sales] VALUES (?, ?, ?, ?, ?, ?)",
    );
    const products = new Map<
      string,
      { id: number; category: string; product: string; sales: number }
    >();
    const categorySales = new Map<string, number>();
    let grandSales = 0;
    for (const [index, observation] of observations.entries()) {
      const key = JSON.stringify([observation.Product, observation.Category]);
      let product = products.get(key);
      if (!product) {
        product = {
          id: products.size + 1,
          category: observation.Category,
          product: observation.Product,
          sales: 0,
        };
        products.set(key, product);
        insertProduct.run(product.id, product.category, product.product);
      }
      const sales = Number(observation.Sales);
      expect(Number.isFinite(sales)).toBe(true);
      product.sales += sales;
      categorySales.set(
        product.category,
        (categorySales.get(product.category) ?? 0) + sales,
      );
      grandSales += sales;
      insertFact.run(
        index + 1,
        product.id,
        1,
        sales,
        null,
        observation["Order ID"],
      );
    }
    const custom = (
      id: string,
      name: string,
      expression: string,
    ): SemanticMeasure => ({
      ...model.measures[0],
      id,
      name,
      expression,
      isAuto: false,
    });
    const exactModel: SemanticModel = {
      ...model,
      version: "superstore-exact-category-grand-shares",
      measures: [
        ...model.measures,
        custom(
          "category-share",
          "Sales % of Category",
          "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product])))",
        ),
        custom(
          "grand-share",
          "Sales % of Grand Total",
          "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product]), ALL(dim_product[category])))",
        ),
      ],
    };
    const started = performance.now();
    const rows = execute(
      {
        measures: ["Sales", "Sales % of Category", "Sales % of Grand Total"],
        rows: [productName, category],
      },
      exactModel,
    );
    const totalMs = performance.now() - started;
    expect(
      totalMs,
      "Local compile + relational query elapsed milliseconds",
    ).toBeLessThan(1_000);
    expect(rows).toHaveLength(products.size);
    for (const row of rows) {
      const expected = products.get(
        JSON.stringify([row.Product, row.Category]),
      )!;
      expect(Number(row.Sales)).toBeCloseTo(expected.sales, 6);
      expect(Number(row["Sales % of Category"])).toBeCloseTo(
        expected.sales / categorySales.get(expected.category)!,
        7,
      );
      expect(Number(row["Sales % of Grand Total"])).toBeCloseTo(
        expected.sales / grandSales,
        7,
      );
    }
  });
});
