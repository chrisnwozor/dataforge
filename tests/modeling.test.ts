import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { profileFile } from "@/lib/profiler";
import { functionalDependency, suggestModel } from "@/lib/modeling/suggest";
import { modelSchema } from "@/lib/modeling/schema";
import { validateModel } from "@/lib/modeling/validate";
import type { SuggestionColumn, SuggestionInput } from "@/lib/modeling/types";

function column(
  name: string,
  type: SuggestionColumn["type"],
  ordinal: number,
  overrides: Partial<SuggestionColumn> = {},
): SuggestionColumn {
  return {
    id: String(ordinal),
    ordinal,
    name,
    type,
    distinctCount: 2,
    nullPct: 0,
    isKeyCandidate: false,
    isNearKeyCandidate: false,
    ...overrides,
  };
}

function input(
  columns: SuggestionColumn[],
  sampledRows: SuggestionInput["sampledRows"] = [],
  overrides: Partial<SuggestionInput> = {},
): SuggestionInput {
  return {
    columns,
    sampledRows,
    rowCount: sampledRows.length,
    duplicateRowCount: 0,
    topic: "Sales",
    ...overrides,
  };
}

describe("rules-based model suggestions", () => {
  it("generates one shared calendar and a foreign key for each date source", () => {
    const model = suggestModel(
      input([
        column("Order Date", "date", 0),
        column("Ship Date", "date", 1),
        column("Sales", "decimal", 2),
      ]),
    );
    expect(model.dimensions).toHaveLength(1);
    expect(model.dimensions[0]).toMatchObject({
      name: "dim_date",
      generated: "date",
      businessKey: "DateKey",
      columnIds: ["0", "1"],
    });
    expect(model.fact.foreignKeys.map((key) => key.name)).toEqual([
      "OrderDateKey",
      "ShipDateKey",
    ]);
    expect(
      model.fact.foreignKeys.every((key) => key.dimensionId === "date"),
    ).toBe(true);
    const single = suggestModel(input([column("Created", "date", 0)]));
    expect(single.fact.foreignKeys[0].name).toBe("DateKey");
  });

  it("assigns numeric measures and AVG non-additive values while excluding ID-like or key columns", () => {
    const names = [
      "Sales",
      "Quantity",
      "Discount",
      "Tax Rate",
      "Margin Pct",
      "Ratio",
      "Unit Price",
      "CustomerID",
      "Account Key",
      "PostalCode",
      "Invoice Number",
      "Unique",
    ];
    const columns = names.map((name, ordinal) =>
      column(name, "decimal", ordinal, { isKeyCandidate: name === "Unique" }),
    );
    const model = suggestModel(input(columns));
    expect(model.fact.measures.map((measure) => measure.name)).toEqual(
      names.slice(0, 7),
    );
    expect(
      model.fact.measures.slice(0, 2).map((measure) => measure.aggregation),
    ).toEqual(["SUM", "SUM"]);
    expect(
      model.fact.measures
        .slice(2)
        .every(
          (measure) =>
            measure.aggregation === "AVG" &&
            measure.additivity === "non-additive",
        ),
    ).toBe(true);
    expect(model.dimensions).toHaveLength(5);
    expect(
      model.fact.measures.every((measure) => measure.reason.length > 0),
    ).toBe(true);
  });

  it("keeps unique and near-key transaction identifiers as degenerate dimensions", () => {
    const columns = [
      column("Order ID", "text", 0, {
        isKeyCandidate: true,
        distinctCount: 200,
      }),
      column("Invoice", "text", 1, {
        isNearKeyCandidate: true,
        distinctCount: 199,
      }),
      column("Transaction", "text", 2, {
        isKeyCandidate: true,
        distinctCount: 200,
      }),
      column("Product", "text", 3, {
        isKeyCandidate: true,
        distinctCount: 200,
      }),
    ];
    const model = suggestModel(input(columns));
    expect(
      model.fact.degenerateDimensions.map((value) => value.columnId),
    ).toEqual(["0", "1", "2"]);
    expect(model.dimensions.map((dimension) => dimension.name)).toEqual([
      "dim_product",
    ]);
    expect(model.fact.grain).toBe(
      "one row per Order ID and Invoice and Transaction",
    );
  });

  it("groups repeating functional dependencies and leaves independent text in its own dimension", () => {
    const columns = [
      column("Customer Name", "text", 0, { distinctCount: 3 }),
      column("Segment", "text", 1),
      column("Region", "text", 2),
    ];
    const rows = [
      ["Alice", "Consumer", "East"],
      ["Bob", "Corporate", "West"],
      ["Carol", "Consumer", "East"],
      ["Alice", "Consumer", "West"],
      ["Bob", "Corporate", "East"],
      ["Carol", "Consumer", "West"],
    ];
    const model = suggestModel(input(columns, rows));
    expect(model.dimensions.map((dimension) => dimension.name)).toEqual([
      "dim_customer",
      "dim_region",
    ]);
    expect(model.dimensions[0]).toMatchObject({
      businessKey: "0",
      columnIds: ["0", "1"],
      attributes: ["1"],
    });
    expect(model.reasons["1"]).toContain(
      "Customer Name determines Segment in 100.0% of 6 rows",
    );
    expect(model.fact.grain).toBe("one row per Customer Name and Region");
  });

  it("does not group text on vacuous mappings from unique row identifiers", () => {
    const model = suggestModel(
      input(
        [
          column("Applicant", "text", 0, { distinctCount: 4 }),
          column("Program", "text", 1),
        ],
        [
          ["A", "Economic"],
          ["B", "Family"],
          ["C", "Economic"],
          ["D", "Family"],
        ],
      ),
    );
    expect(model.dimensions).toHaveLength(2);
  });

  it("flags duplicate rows and reports when dependency evidence is sampled", () => {
    const columns = [
      column("Region", "text", 0),
      column("Sales", "decimal", 1),
    ];
    const model = suggestModel(
      input(
        columns,
        [
          ["East", "10"],
          ["West", "20"],
        ],
        { rowCount: 100, duplicateRowCount: 3 },
      ),
    );
    expect(model.removeExactDuplicates).toBe(false);
    expect(model.warnings).toContainEqual(
      expect.stringContaining("3 fully duplicated rows"),
    );
    expect(model.warnings).toContainEqual(
      expect.stringContaining("2 sampled rows out of 100"),
    );
  });

  it("is deterministic and does not mutate its inputs", () => {
    const source = input(
      [column("Region", "text", 0), column("Sales", "decimal", 1)],
      [
        ["East", "12"],
        ["West", "14"],
      ],
    );
    const before = JSON.stringify(source);
    expect(suggestModel(source)).toEqual(suggestModel(source));
    expect(JSON.stringify(source)).toBe(before);
  });

  it("bounds identifiers, grain, and joined explanations so wide/long-header suggestions validate", () => {
    const columns = Array.from({ length: 50 }, (_, ordinal) =>
      column(`Customer ${ordinal} ${"n".repeat(300)}`, "text", ordinal),
    );
    const model = suggestModel(
      input(
        columns,
        [
          columns.map(() => "Alice"),
          columns.map(() => "Bob"),
          columns.map(() => "Alice"),
          columns.map(() => "Bob"),
        ],
        { topic: "s".repeat(500) },
      ),
    );
    expect(modelSchema.safeParse(model).success).toBe(true);
    expect(
      model.dimensions.some((dimension) => dimension.attributes.length > 20),
    ).toBe(true);
  });

  it("classifies full source headers before clipping long editable aliases", () => {
    const prefix = "Long source heading ".repeat(80);
    const columns = [
      column(`${prefix}ID`, "integer", 0),
      column(`${prefix}Discount`, "decimal", 1),
      column(`${prefix}Transaction`, "text", 2, { isKeyCandidate: true }),
    ];
    const model = suggestModel(input(columns));
    expect(model.fact.measures.map((measure) => measure.columnId)).toEqual([
      "1",
    ]);
    expect(model.fact.measures[0]).toMatchObject({
      aggregation: "AVG",
      additivity: "non-additive",
    });
    expect(
      model.dimensions.flatMap((dimension) => dimension.columnIds),
    ).toContain("0");
    expect(model.fact.degenerateDimensions[0].columnId).toBe("2");
    expect(
      Object.values(model.columnNames).every((name) => name.length <= 128),
    ).toBe(true);
    expect(modelSchema.safeParse(model).success).toBe(true);
  });

  it("bounds dependency analysis and keeps every skipped source assigned", () => {
    const columns = Array.from({ length: 200 }, (_, ordinal) =>
      column(`Value ${ordinal}`, "text", ordinal, { distinctCount: 1 }),
    );
    const rows = [columns.map(() => "Only")];
    const model = suggestModel(input(columns, rows));
    expect(model.warnings).toContainEqual(
      expect.stringContaining("bounded work budget"),
    );
    expect(model.dimensions).toHaveLength(columns.length);
    expect(
      new Set(model.dimensions.flatMap((dimension) => dimension.columnIds))
        .size,
    ).toBe(columns.length);
    expect(modelSchema.safeParse(model).success).toBe(true);
  });

  it("produces the expected real Superstore star schema", async () => {
    const profile = await profileFile(
      join(process.cwd(), "samples/superstore_sales.csv"),
      "CSV",
    );
    const model = suggestModel(
      input(
        profile.columns.map((item) => ({
          ...item,
          id: String(item.ordinal),
          type: item.inferredType,
        })),
        profile.sampledRows,
        {
          rowCount: profile.rowCount,
          duplicateRowCount: profile.duplicateRowCount,
          topic: "superstore_sales.csv",
        },
      ),
    );
    expect(model.fact.name).toBe("fact_sales");
    expect(
      model.fact.measures.map((measure) => [measure.name, measure.aggregation]),
    ).toEqual([
      ["Sales", "SUM"],
      ["Quantity", "SUM"],
      ["Discount", "AVG"],
      ["Profit", "SUM"],
    ]);
    const names = (ids: string[]) => ids.map((id) => model.columnNames[id]);
    expect(
      model.dimensions.map((dimension) => [
        dimension.name,
        names(dimension.columnIds),
      ]),
    ).toEqual([
      ["dim_date", ["Order Date"]],
      ["dim_customer", ["Customer Name", "Segment"]],
      ["dim_product", ["Product", "Category"]],
      ["dim_region", ["Region"]],
    ]);
    expect(model.fact.degenerateDimensions.map((value) => value.name)).toEqual([
      "Order ID",
    ]);
    expect(modelSchema.safeParse(model).success).toBe(true);
    expect(
      validateModel(
        model,
        profile.columns.map((item) => ({
          id: String(item.ordinal),
          name: item.name,
        })),
      ),
    ).toEqual([]);
  });

  it("profiles and models the no-date IRCC fixture without inventing a calendar", async () => {
    const profile = await profileFile(
      join(process.cwd(), "samples/ircc-style.csv"),
      "CSV",
    );
    const model = suggestModel(
      input(
        profile.columns.map((item) => ({
          ...item,
          id: String(item.ordinal),
          type: item.inferredType,
        })),
        profile.sampledRows,
        { rowCount: profile.rowCount, topic: "IRCC admissions" },
      ),
    );
    expect(
      model.dimensions.some((dimension) => dimension.generated === "date"),
    ).toBe(false);
    expect(
      model.dimensions
        .find((dimension) => dimension.name === "dim_immigration_program")
        ?.columnIds.map((id) => model.columnNames[id]),
    ).toEqual(["Immigration Program", "Program Group"]);
    expect(
      model.fact.measures.find((measure) => measure.name === "Approval Rate"),
    ).toMatchObject({ aggregation: "AVG", additivity: "non-additive" });
    expect(modelSchema.safeParse(model).success).toBe(true);
  });
});

describe("functional dependencies", () => {
  it("accepts exactly one percent violating rows and rejects more", () => {
    const rows: (string | null)[][] = Array.from(
      { length: 100 },
      (_, index) => [
        index < 50 ? "Alice" : "Bob",
        index < 50 ? "Consumer" : "Corporate",
      ],
    );
    rows[0][1] = "Corporate";
    expect(functionalDependency(rows, 0, 1)).toMatchObject({
      holds: true,
      confidence: 0.99,
      violatingRows: 1,
      evaluatedRows: 100,
    });
    rows[1][1] = "Corporate";
    expect(functionalDependency(rows, 0, 1)).toMatchObject({
      holds: false,
      confidence: 0.98,
      violatingRows: 2,
    });
  });

  it("ignores null determinants and treats missing dependent values as mapped values", () => {
    expect(
      functionalDependency(
        [
          [null, "A"],
          ["", "B"],
          ["Alice", "Consumer"],
          ["Alice", null],
          ["Bob", "Corporate"],
        ],
        0,
        1,
      ),
    ).toMatchObject({ holds: false, evaluatedRows: 3, violatingRows: 1 });
    expect(functionalDependency([[null, null]], 0, 1)).toMatchObject({
      holds: false,
      confidence: 0,
      evaluatedRows: 0,
    });
  });

  it("weights violations by rows rather than determinant-group count", () => {
    const rows = [
      ...Array.from({ length: 198 }, () => ["Alice", "Consumer"]),
      ["Bob", "Consumer"],
      ["Bob", "Corporate"],
    ];
    expect(functionalDependency(rows, 0, 1)).toMatchObject({
      holds: true,
      violatingRows: 1,
      confidence: 0.995,
    });
  });
});

describe("model validation", () => {
  it("reports every required structural modeling issue without preventing draft schema validation", () => {
    const columns = [
      column("Sales", "decimal", 0),
      column("Region", "text", 1),
    ];
    const model = suggestModel(input(columns));
    model.fact.grain = "";
    model.fact.measures = [];
    model.dimensions[0].businessKey = "";
    model.dimensions.push({
      ...model.dimensions[0],
      id: "second",
      name: model.fact.name,
    });
    model.unassigned.push("0");
    expect(modelSchema.safeParse(model).success).toBe(true);
    const codes = validateModel(model, columns).map((issue) => issue.code);
    for (const code of [
      "missing-grain",
      "no-measures",
      "missing-business-key",
      "duplicate-assignment",
      "unassigned-columns",
      "duplicate-table-name",
    ])
      expect(codes).toContain(code);
  });

  it("reports unknown references and duplicate unassigned occurrences", () => {
    const columns = [column("Sales", "decimal", 0)];
    const model = suggestModel(input(columns));
    model.fact.measures[0].columnId = "999";
    model.unassigned = ["0", "0"];
    expect(validateModel(model, columns).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "unknown-column",
        "duplicate-assignment",
        "unassigned-columns",
      ]),
    );
  });

  it("rejects malformed, oversized, or unknown JSON fields", () => {
    const model = suggestModel(input([column("Sales", "decimal", 0)]));
    expect(modelSchema.safeParse(model).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, unexpected: true }).success).toBe(
      false,
    );
    expect(
      modelSchema.safeParse({
        ...model,
        fact: { ...model.fact, grain: "x".repeat(2001) },
      }).success,
    ).toBe(false);
    expect(
      modelSchema.safeParse({
        ...model,
        fact: {
          ...model.fact,
          measures: [{ ...model.fact.measures[0], aggregation: "MEDIAN" }],
        },
      }).success,
    ).toBe(false);
  });
});
