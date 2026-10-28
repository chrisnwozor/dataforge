import { join } from "node:path";
import { profileFile } from "@/lib/profiler";
import { suggestModel } from "@/lib/modeling/suggest";
import { deriveSemanticModel } from "@/lib/semantic/derive";
import type { SemanticModel } from "@/lib/semantic/types";

export const performanceMeasureDefinitions = [
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
  ["Profit per Order", "DIVIDE([Profit], [Distinct Order ID])"],
  ["Sales per Unit", "DIVIDE([Sales], [Quantity])"],
  ["Rounded Margin %", "ROUND([Profit Margin %], 2)"],
  ["Absolute Profit", "ABS([Profit])"],
  ["East Sales", "CALCULATE([Sales], dim_region[Region] = 'East')"],
  ["Positive Margin %", "IF([Profit] > 0, [Profit Margin %], 0)"],
  [
    "Sales % of Category",
    "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product])))",
  ],
  [
    "Sales % of Grand Total",
    "DIVIDE([Sales], CALCULATE([Sales], ALL(dim_product[product]), ALL(dim_product[category])))",
  ],
] as const;

/** Add the reported derived measures; this setup is deliberately outside timed compilation. */
export function addPerformanceMeasures(model: SemanticModel): SemanticModel {
  return {
    ...model,
    version: `${model.version}:performance-v1`,
    measures: [
      ...model.measures,
      ...performanceMeasureDefinitions.map(([name, expression], index) => ({
        id: `performance:${index}`,
        name,
        expression,
        format: name.includes("%") ? ("percent" as const) : ("number" as const),
        folder: "Performance regression",
        description:
          "Regression fixture for the reported Superstore query slowdown.",
        isAuto: false,
        createdAt: "2026-10-27T12:00:00.000Z",
        updatedAt: "2026-10-27T12:00:00.000Z",
      })),
    ],
  };
}

export async function createSuperstoreSemanticFixture(): Promise<SemanticModel> {
  const profile = await profileFile(
    join(process.cwd(), "samples/superstore_sales.csv"),
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
    topic: "superstore_sales",
  });
  return addPerformanceMeasures(
    deriveSemanticModel({
      project: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Superstore performance",
        sourceFile: "superstore_sales.csv",
        sourceType: "CSV",
      },
      model,
      columns: profile.columns.map((column) => ({
        ...column,
        overrideType: null,
        maxLength: column.maxLength ?? 0,
        maxDecimalPlaces: column.maxDecimalPlaces ?? 0,
      })),
      sampledRows: profile.sampledRows,
      updatedAt: "2026-10-27T12:00:00.000Z",
    }),
  );
}

export function performanceMeasureSets(model: SemanticModel) {
  const cumulative = [
    "Sales",
    "Profit Margin %",
    "Avg Order Value",
    "Sales % of Total",
    "Furniture Sales",
  ];
  return [
    ...cumulative.map((_, index) => ({
      name: cumulative.slice(0, index + 1).join(" + "),
      measures: cumulative.slice(0, index + 1),
      budgetMs: 50,
    })),
    {
      name: "all measures",
      measures: model.measures.map((measure) => measure.name),
      budgetMs: 250,
    },
  ];
}

export function categoryReference(model: SemanticModel) {
  const table = model.tables.find((table) =>
    table.columns.some((column) => column.name === "Category"),
  )!;
  return {
    table: table.id,
    column: table.columns.find((column) => column.name === "Category")!.id,
  };
}

export function productCategoryReferences(model: SemanticModel) {
  const table = model.tables.find((table) =>
    table.columns.some((column) => column.name === "Product"),
  )!;
  return ["Product", "Category"].map((name) => ({
    table: table.id,
    column: table.columns.find((column) => column.name === name)!.id,
  }));
}
