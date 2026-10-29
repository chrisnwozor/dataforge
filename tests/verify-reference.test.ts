import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildReferenceQuery,
  classifyMeasure,
  isAdditiveMeasure,
  UnsupportedReferenceError,
} from "@/lib/verify/reference";
import type { SemanticModel, SemanticMeasure } from "@/lib/semantic/types";
import type { SemanticQuery } from "@/lib/semantic/query/types";
import type { ReferenceSql } from "@/lib/verify/types";
// Importing/calling the production compiler is a hard failure in this oracle suite.
vi.mock("@/lib/semantic/query/compile", () => {
  throw new Error(
    "The independent oracle must never import the semantic compiler",
  );
});
vi.mock("@/lib/semantic/expr/compiler", () => {
  throw new Error(
    "The independent oracle must never import the expression compiler",
  );
});
const measure = (
  id: string,
  name: string,
  expression: string,
): SemanticMeasure => ({
  id,
  name,
  expression,
  format: name.includes("%") ? "percent" : "number",
  folder: "Tests",
  description: "",
  isAuto: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});
export const referenceModel: SemanticModel = {
  projectId: "independent",
  version: "1",
  factTableId: "fact",
  tables: [
    {
      id: "fact",
      name: "fact_sales",
      schema: "dw",
      sqlName: "fact_sales",
      kind: "fact",
      keyColumnId: "fact:key",
      columns: [
        {
          id: "fact:key",
          tableId: "fact",
          name: "key",
          sqlName: "fact_key",
          type: "number",
          role: "key",
        },
        ...(
          [
            ["Sales", "sales", "number", "measure-source"],
            ["Profit", "profit", "number", "measure-source"],
            ["Order ID", "order_id", "string", "attribute"],
            ["product_key", "product_key", "number", "key"],
            ["DateKey", "DateKey", "number", "key"],
          ] as const
        ).map(([name, sqlName, type, role]) => ({
          id: name,
          tableId: "fact",
          name,
          sqlName,
          type,
          role,
        })),
      ],
    },
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
          name: "product_key",
          sqlName: "product_key",
          type: "number",
          role: "key",
        },
        {
          id: "Product",
          tableId: "product",
          name: "Product",
          sqlName: "product",
          type: "string",
          role: "attribute",
          distinctCount: 3,
        },
        {
          id: "Category",
          tableId: "product",
          name: "Category",
          sqlName: "category",
          type: "string",
          role: "attribute",
          distinctCount: 2,
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
        ...(
          [
            ["Date", "date"],
            ["Year", "number"],
            ["Month", "number"],
            ["Quarter", "number"],
          ] as const
        ).map(([name, type]) => ({
          id: name,
          tableId: "date",
          name,
          sqlName: name,
          type,
          role: "attribute" as const,
          distinctCount: name === "Date" ? 500 : 12,
        })),
      ],
    },
  ],
  relationships: [
    {
      id: "product-relation",
      fromTableId: "fact",
      fromColumnId: "product_key",
      toTableId: "product",
      toColumnId: "product:key",
      cardinality: "many-to-one",
    },
    {
      id: "date-relation",
      fromTableId: "fact",
      fromColumnId: "DateKey",
      toTableId: "date",
      toColumnId: "date:key",
      cardinality: "many-to-one",
    },
  ],
  date: {
    tableId: "date",
    dateColumnId: "Date",
    keyColumnId: "date:key",
    factColumnId: "DateKey",
  },
  hierarchies: [
    {
      id: "date-tree",
      name: "Calendar",
      tableId: "date",
      levels: ["Year", "Month"],
      isAuto: true,
    },
  ],
  measures: [
    measure("sales", "Sales", "SUM(fact_sales[Sales])"),
    measure("profit", "Profit", "SUM(fact_sales[Profit])"),
    measure("margin", "Margin %", "DIVIDE([Profit],[Sales])"),
    measure("orders", "Orders", "DISTINCTCOUNT(fact_sales[Order ID])"),
    measure("row-count", "Row Count", "COUNT_BIG(*)"),
    measure("avg", "Average Sales", "AVG(fact_sales[Sales])"),
    measure("min", "Minimum Sales", "MIN(fact_sales[Sales])"),
    measure("max", "Maximum Sales", "MAX(fact_sales[Sales])"),
    measure(
      "share",
      "Sales % of Total",
      "DIVIDE([Sales],CALCULATE([Sales],ALL(dim_product[Category])))",
    ),
    measure(
      "category-share",
      "Sales % of Category",
      "DIVIDE([Sales],CALCULATE([Sales],ALL(dim_product[Product])))",
    ),
    measure(
      "furniture",
      "Furniture Sales",
      "CALCULATE([Sales], dim_product[Category] = 'Furniture')",
    ),
    measure("ytd", "Sales YTD", "YTD([Sales])"),
    measure("mtd", "Sales MTD", "MTD([Sales])"),
    measure("qtd", "Sales QTD", "QTD([Sales])"),
    measure("ly", "Sales LY", "SAMEPERIODLASTYEAR([Sales])"),
    measure("yoy", "Sales YoY %", "DIVIDE([Sales]-[Sales LY],[Sales LY])"),
    measure("previous", "Previous Month", "PREVIOUSPERIOD([Sales],MONTH)"),
    measure("round", "Rounded Margin", "ROUND(ABS([Margin %]), 3)"),
    measure("if", "Positive Profit", "IF([Profit]>0,[Sales],0)"),
  ],
};
export const refQuery = (
  measures: string[],
  rows: SemanticQuery["rows"] = [],
  patch: Partial<SemanticQuery> = {},
): SemanticQuery => ({
  measures,
  rows,
  filters: [],
  orderBy: [],
  limit: 50000,
  hideUnknown: false,
  ...patch,
});
export const observations = [
  {
    year: 2023,
    month: 1,
    day: 10,
    sales: 100,
    profit: 10,
    product: 1,
    order: "A",
  },
  {
    year: 2023,
    month: 2,
    day: 10,
    sales: 200,
    profit: 20,
    product: 2,
    order: "A",
  },
  {
    year: 2024,
    month: 1,
    day: 10,
    sales: 150,
    profit: 30,
    product: 1,
    order: "B",
  },
  {
    year: 2024,
    month: 2,
    day: 10,
    sales: 250,
    profit: 50,
    product: 2,
    order: "C",
  },
  {
    year: 2024,
    month: 2,
    day: 20,
    sales: 100,
    profit: 5,
    product: 3,
    order: "D",
  },
];
/** Only SQL dialect syntax is adapted. Aggregate/filter/window logic remains the
 * independent builder's actual SQL, then is reconciled to plain JS arithmetic. */
export function executeReference(query: ReferenceSql) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "ATTACH DATABASE ':memory:' AS dw; CREATE TABLE dw.fact_sales(fact_key INTEGER,sales REAL,profit REAL,order_id TEXT,product_key INTEGER,DateKey INTEGER); CREATE TABLE dw.dim_product(product_key INTEGER,product TEXT,category TEXT); CREATE TABLE dw.dim_date(DateKey INTEGER,Date TEXT,Year INTEGER,Month INTEGER,Quarter INTEGER);",
  );
  db.exec(
    "INSERT INTO dw.dim_product VALUES(1,'Desk','Furniture'),(2,'Monitor','Technology'),(3,'Bookcase','Furniture'),(-1,'Unknown','Unknown')",
  );
  for (const [i, o] of observations.entries()) {
    const date = `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}`,
      key = o.year * 10000 + o.month * 100 + o.day;
    db.prepare("INSERT INTO dw.fact_sales VALUES(?,?,?,?,?,?)").run(
      i + 1,
      o.sales,
      o.profit,
      o.order,
      o.product,
      key,
    );
    if (!db.prepare("SELECT 1 FROM dw.dim_date WHERE DateKey=?").get(key))
      db.prepare("INSERT INTO dw.dim_date VALUES(?,?,?,?,?)").run(
        key,
        date,
        o.year,
        o.month,
        Math.ceil(o.month / 3),
      );
  }
  db.function("YEAR", (v) =>
    v === null ? null : Number(String(v).slice(0, 4)),
  );
  db.function("MONTH", (v) =>
    v === null ? null : BigInt(Number(String(v).slice(5, 7))),
  );
  db.function("DATEFROMPARTS", (y, m, d) =>
    y === null || m === null || d === null
      ? null
      : `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
  );
  db.function("DATEADD", (unit, n, v) => {
    if (v === null) return null;
    const date = new Date(String(v) + "T00:00:00Z");
    if (unit === "YEAR") date.setUTCFullYear(date.getUTCFullYear() + Number(n));
    else if (unit === "MONTH") date.setUTCMonth(date.getUTCMonth() + Number(n));
    else if (unit === "QUARTER")
      date.setUTCMonth(date.getUTCMonth() + 3 * Number(n));
    else date.setUTCDate(date.getUTCDate() + Number(n));
    return date.toISOString().slice(0, 10);
  });
  const sql =
    query.sql
      .replace("SELECT TOP (@__df_limit)", "SELECT")
      .replace(/CONVERT\(decimal\(38, 10\), (\[[^\]]+\]\.\[[^\]]+\])\)/g, "$1")
      .replace(/CONVERT\(date, (\[[^\]]+\]\.\[[^\]]+\])\)/g, "$1")
      .replace(/CONVERT\(date, '00010101', 112\)/g, "'0001-01-01'")
      .replace(/COUNT_BIG\(/g, "COUNT(")
      .replace(/DATEADD\((YEAR|MONTH|QUARTER|DAY),/g, "DATEADD('$1',")
      .replace(/N'/g, "'")
      .replace(/;\s*$/, "") + " LIMIT @__df_limit;";
  try {
    const statement = db.prepare(sql);
    statement.setAllowBareNamedParameters(true);
    return statement.all(
      Object.fromEntries(
        query.params.map((p) => [
          p.name,
          typeof p.value === "boolean" ? Number(p.value) : p.value,
        ]),
      ),
    );
  } finally {
    db.close();
  }
}
describe("independent reference SQL", () => {
  it("snapshots a direct aggregate with physical names and typed limit", () => {
    const q = buildReferenceQuery(referenceModel, refQuery(["sales"]));
    expect({ sql: q.sql, params: q.params }).toMatchSnapshot();
    expect(q.sql).not.toMatch(/\bWITH\b|#[a-z_]+|__df_(?:base|scalar)/i);
  });
  it("snapshots grouped ratios, ALL denominators and parameterized CALCULATE", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(
        ["margin", "share", "furniture"],
        [{ table: "product", column: "Category" }],
      ),
    );
    expect({ sql: q.sql, params: q.params }).toMatchSnapshot();
    expect(q.sql).not.toContain("N'Furniture'");
    expect(q.params.some((p) => p.value === "Furniture")).toBe(true);
  });
  it("snapshots independent window-based year/month and prior-year references", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(
        ["ytd", "mtd", "qtd", "ly", "yoy"],
        [
          { table: "date", column: "Year" },
          { table: "date", column: "Month" },
        ],
      ),
    );
    expect(q.sql).toContain("OVER (PARTITION BY");
    expect(q.sql).toContain("DATEADD(YEAR, -1");
    expect(q.sql).not.toMatch(/\bWITH\b|#[a-z_]+/i);
    expect(q.sql).toMatchSnapshot();
  });
  it("never imports production compilation or generation paths", () => {
    for (const path of ["lib/verify/reference.ts", "lib/verify/semantic.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(?:\/query\/(?:compile|materialize|simple)|\/expr\/(?:compiler|checker|index)|\/sql\/|\/semantic\/expr["'])/,
      );
    }
  });
  it("reconciles SUM/AVG/MIN/MAX/count/distinct/ratio/IF/ABS/ROUND to JS arithmetic", () => {
    const selected = [
        "sales",
        "profit",
        "avg",
        "min",
        "max",
        "orders",
        "row-count",
        "margin",
        "round",
        "if",
      ],
      q = buildReferenceQuery(referenceModel, refQuery(selected)),
      actual = executeReference(q)[0];
    const sum = observations.reduce((n, r) => n + r.sales, 0),
      profit = observations.reduce((n, r) => n + r.profit, 0);
    const expected = [
      sum,
      profit,
      sum / observations.length,
      Math.min(...observations.map((r) => r.sales)),
      Math.max(...observations.map((r) => r.sales)),
      new Set(observations.map((r) => r.order)).size,
      observations.length,
      profit / sum,
      Math.round(Math.abs(profit / sum) * 1000) / 1000,
      sum,
    ];
    selected.forEach((_, i) =>
      expect(Number(actual[`v${i}`])).toBeCloseTo(expected[i], 9),
    );
  });
  it("reconciles categories and CALCULATE/ALL against a separate filtered JS calculation", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(
        ["sales", "share", "furniture"],
        [{ table: "product", column: "Category" }],
      ),
    );
    const rows = executeReference(q),
      sum = observations.reduce((n, r) => n + r.sales, 0),
      furniture = observations
        .filter((r) => r.product !== 2)
        .reduce((n, r) => n + r.sales, 0);
    for (const row of rows) {
      const own = observations
        .filter(
          (r) => (r.product === 2 ? "Technology" : "Furniture") === row.g0,
        )
        .reduce((n, r) => n + r.sales, 0);
      expect(row.v0).toBe(own);
      expect(Number(row.v1)).toBeCloseTo(own / sum, 9);
      expect(row.v2).toBe(furniture);
    }
  });
  it("reconciles year/month window outputs to independent date-range array calculations", () => {
    const selected = ["sales", "ytd", "mtd", "qtd", "ly", "yoy"],
      q = buildReferenceQuery(
        referenceModel,
        refQuery(selected, [
          { table: "date", column: "Year" },
          { table: "date", column: "Month" },
        ]),
      );
    for (const row of executeReference(q)) {
      const year = Number(row.g0),
        month = Number(row.g1),
        current = observations
          .filter((r) => r.year === year && r.month === month)
          .reduce((n, r) => n + r.sales, 0),
        ytd = observations
          .filter((r) => r.year === year && r.month <= month)
          .reduce((n, r) => n + r.sales, 0),
        lyRows = observations.filter(
          (r) => r.year === year - 1 && r.month === month,
        ),
        ly = lyRows.length ? lyRows.reduce((n, r) => n + r.sales, 0) : null;
      expect(row.v0).toBe(current);
      expect(row.v1).toBe(ytd);
      expect(row.v2).toBe(current);
      expect(row.v3).toBe(ytd);
      expect(row.v4).toBe(ly);
      expect(row.v5 === null ? null : Number(row.v5)).toBe(
        ly === null ? null : (current - ly) / ly,
      );
    }
  });
  it("reconciles YTD grand total to the latest date year rather than a whole multi-year range", () => {
    const q = buildReferenceQuery(referenceModel, refQuery(["ytd"]));
    expect(executeReference(q)[0].v0).toBe(
      observations
        .filter((r) => r.year === 2024)
        .reduce((sum, r) => sum + r.sales, 0),
    );
  });
  it("honors date sorting and applies a typed row limit for KPI latest-date references", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(["sales"], [{ table: "date", column: "Date" }], {
        limit: 1,
        orderBy: [{ ref: { table: "date", column: "Date" }, dir: "desc" }],
      }),
    );
    expect(q.sql).toContain("ORDER BY [g0] DESC");
    expect(q.params.at(-1)).toEqual({
      name: "__df_limit",
      value: 2,
      type: "number",
    });
    expect(executeReference(q)[0].g0).toBe("2024-02-20");
  });
  it("uses independent null-safe grouping joins without sentinel collisions", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(["sales"], [{ table: "product", column: "Category" }]),
    );
    expect(q.sql).toContain("CASE WHEN [anchor].[g0] IS NULL");
    expect(q.sql).toContain("COALESCE([anchor].[g0], N'')");
  });
  it("parameterizes hostile literal values and quotes physical identifier delimiters", () => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(["sales"], [], {
        filters: [
          {
            attribute: { table: "product", column: "Category" },
            op: "eq",
            value: "x'; DROP TABLE x;--",
          },
        ],
      }),
    );
    expect(q.sql).not.toContain("DROP TABLE");
    expect(q.params.some((p) => p.value === "x'; DROP TABLE x;--")).toBe(true);
    const renamed = structuredClone(referenceModel);
    renamed.tables[0].sqlName = "fact]x";
    expect(buildReferenceQuery(renamed, refQuery(["sales"])).sql).toContain(
      "[fact]]x]",
    );
  });
  it("classifies only safe additive aggregations and detects ratios/time/ALL", () => {
    expect(isAdditiveMeasure(referenceModel, "sales")).toBe(true);
    expect(isAdditiveMeasure(referenceModel, "row-count")).toBe(true);
    expect(isAdditiveMeasure(referenceModel, "orders")).toBe(false);
    expect(isAdditiveMeasure(referenceModel, "avg")).toBe(false);
    expect(classifyMeasure(referenceModel, "share")).toMatchObject({
      ratio: true,
      percentOfTotal: true,
    });
    expect(classifyMeasure(referenceModel, "yoy").time).toBe(true);
  });
  it("rejects unsupported function, Top N, cycles, ambiguous references, invalid limits and missing calendar truthfully", () => {
    const m = structuredClone(referenceModel);
    m.measures.push(
      measure("unsupported", "Unsupported", "MEDIAN(fact_sales[Sales])"),
      measure("cycle", "Cycle", "[Cycle]"),
      measure("time-distinct", "Orders YTD", "YTD([Orders])"),
    );
    for (const name of ["unsupported", "cycle", "time-distinct"])
      expect(() => buildReferenceQuery(m, refQuery([name]))).toThrow(
        UnsupportedReferenceError,
      );
    expect(() =>
      buildReferenceQuery(
        m,
        refQuery(["sales"], [], { topN: { measure: "sales", n: 2 } }),
      ),
    ).toThrow(/Top N/);
    expect(() =>
      buildReferenceQuery(m, refQuery(["sales"], [], { limit: 0 })),
    ).toThrow();
    delete m.date;
    expect(() => buildReferenceQuery(m, refQuery(["ytd"]))).toThrow(
      /date dimension/,
    );
    m.measures.push(measure("duplicate", "Sales", "COUNT_BIG(*)"));
    expect(() => buildReferenceQuery(m, refQuery(["sales"]))).toThrow(
      /ambiguous/,
    );
  });
  it.each([
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "notIn",
    "isNull",
    "isNotNull",
  ] as const)("renders bounded parameterized %s filters", (op) => {
    const q = buildReferenceQuery(
      referenceModel,
      refQuery(["sales"], [], {
        filters: [
          {
            attribute: { table: "product", column: "Category" },
            op,
            value: "Furniture",
            values: ["Furniture", null],
          },
        ],
      }),
    );
    expect(q.sql).toContain("WHERE");
    expect(q.sql).not.toContain("'Furniture'");
  });
  it("preserves MIN/MAX date/text typing and NULL-aware IF predicates", () => {
    const m = structuredClone(referenceModel);
    m.measures.push(
      measure("date-min", "Earliest Date", "MIN(dim_date[Date])"),
      measure("order-min", "First ID", "MIN(fact_sales[Order ID])"),
      measure("null-if", "Missing Sales", "IF([Sales] = NULL, 0, [Sales])"),
      measure("boolean-if", "Boolean", "IF(TRUE AND NOT FALSE,[Sales],0)"),
    );
    const q = buildReferenceQuery(
      m,
      refQuery(["date-min", "order-min", "null-if", "boolean-if"]),
    );
    expect(q.columns.map((c) => c.type)).toEqual([
      "date",
      "string",
      "number",
      "number",
    ]);
    expect(q.sql).toContain(" IS NULL");
    expect(q.sql).toContain(" = 1");
    const row = executeReference(q)[0];
    expect(row.v0).toBe("2023-01-10");
    expect(row.v1).toBe("A");
    expect(row.v2).toBe(800);
    expect(row.v3).toBe(800);
  });
  it("uses complete calendar periods for LY even when current-period edge dates have no facts", () => {
    const previous = observations[1];
    observations.push({
      year: 2023,
      month: 2,
      day: 25,
      sales: 75,
      profit: 5,
      product: 1,
      order: "Extra",
    });
    try {
      const rows = executeReference(
        buildReferenceQuery(
          referenceModel,
          refQuery(
            ["ly"],
            [
              { table: "date", column: "Year" },
              { table: "date", column: "Month" },
            ],
          ),
        ),
      );
      expect(rows.find((r) => r.g0 === 2024 && r.g1 === 2)?.v0).toBe(
        previous.sales + 75,
      );
    } finally {
      observations.pop();
    }
  });
  it("does not pretend a noncontiguous month-only time context is a continuous date range", () => {
    expect(() =>
      buildReferenceQuery(
        referenceModel,
        refQuery(["ytd"], [{ table: "date", column: "Month" }]),
      ),
    ).toThrow(/set-of-dates oracle/);
  });
  it("truthfully skips partial-date-filter time contexts instead of widening them silently", () => {
    expect(() =>
      buildReferenceQuery(
        referenceModel,
        refQuery(["ytd"], [{ table: "date", column: "Year" }], {
          filters: [
            {
              attribute: { table: "date", column: "Date" },
              op: "gte",
              value: "2024-02-15",
            },
          ],
        }),
      ),
    ).toThrow(/set-of-dates oracle/);
  });
});
