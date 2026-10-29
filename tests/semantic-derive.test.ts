import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { profileFile } from "@/lib/profiler";
import { suggestModel } from "@/lib/modeling/suggest";
import { buildSqlContext } from "@/lib/sql/context";
import {
  deriveSemanticModel,
  type SemanticDerivationInput,
} from "@/lib/semantic/derive";
import { compile } from "@/lib/semantic/expr";
import {
  semanticEditsSchema,
  semanticModelSchema,
} from "@/lib/semantic/schema";

let input: SemanticDerivationInput;
beforeAll(async () => {
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
  input = {
    project: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Superstore",
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
  };
});
describe("derived semantic defaults", () => {
  it("exposes profiled cardinality without SQL lookups and conservative calendar bounds", () => {
    const semantic = semanticModelSchema.parse(deriveSemanticModel(input));
    for (const table of semantic.tables) {
      for (const column of table.columns.filter((entry) => entry.role === "attribute" && entry.sourceColumnId)) {
        expect(column.distinctCount).toBe(input.columns.find((entry) => String(entry.ordinal) === column.sourceColumnId)?.distinctCount);
      }
    }
    const calendar = semantic.tables.find((table) => table.id === semantic.date?.tableId)!;
    expect(calendar.columns.find((column) => column.name === "Date")!.distinctCount).toBeGreaterThan(500);
    expect(calendar.columns.find((column) => column.name === "Month")!.distinctCount).toBe(12);
    expect(calendar.columns.find((column) => column.name === "Quarter")!.distinctCount).toBe(4);
    expect(calendar.columns.find((column) => column.name === "Year")!.distinctCount).toBeLessThan(500);
    const unknown = structuredClone(semantic);
    unknown.tables[0].columns[0].distinctCount = -1;
    expect(semanticModelSchema.safeParse(unknown).success).toBe(false);
  });
  it("does not count generated calendar padding as observed years for starter trends", () => {
    const short = structuredClone(input);
    for (const column of short.columns.filter((column) => column.inferredType === "date")) {
      column.minValue = "2021-01-01";
      column.maxValue = "2022-12-31";
    }
    const semantic = deriveSemanticModel(short);
    const calendar = semantic.tables.find((table) => table.id === semantic.date?.tableId)!;
    expect(calendar.columns.find((column) => column.name === "Year")?.distinctCount).toBe(2);
    expect(calendar.columns.find((column) => column.name === "Date")!.distinctCount).toBeGreaterThan(500);
  });
  it("supports every default for a wide fact beyond 256 measures and preserves display names", () => {
    const wide = structuredClone(input);
    const source = wide.columns.find((column) => column.name === "Sales")!;
    const measure = wide.model.fact.measures.find(
      (column) => column.name === "Sales",
    )!;
    for (let ordinal = 20; ordinal < 70; ordinal++) {
      wide.columns.push({ ...source, ordinal, name: `Value ${ordinal}` });
      wide.model.fact.measures.push({
        ...measure,
        columnId: String(ordinal),
        name: `Value ${ordinal}`,
      });
      wide.model.columnNames[String(ordinal)] = `Value ${ordinal}`;
    }
    wide.model.fact.name = " fact_sales ";
    const semantic = semanticModelSchema.parse(deriveSemanticModel(wide));
    expect(semantic.measures.length).toBeGreaterThan(256);
    expect(
      semanticEditsSchema.safeParse({
        measures: semantic.measures,
        hierarchies: semantic.hierarchies,
        version: semantic.version,
      }).success,
    ).toBe(true);
    expect(semantic.tables[0].name).toBe(" fact_sales ");
    expect(() =>
      compile(
        semantic.measures.find((value) => value.name === "Sales")!.expression,
        semantic,
      ),
    ).not.toThrow();
  });
  it("uses exact generated SQL table/column names and fact relationships", () => {
    const semantic = deriveSemanticModel(input);
    const context = buildSqlContext({
      ...input,
      options: {
        incremental: false,
        dedupe: false,
        database: "DataForge",
        generatedAt: "test",
      },
    });
    expect(semantic.tables[0].sqlName).toBe(context.factTable);
    expect(
      semantic.tables[0].columns
        .filter((column) => column.role === "measure-source")
        .map((column) => column.sqlName),
    ).toEqual(context.measures.map((column) => column.name));
    expect(semantic.relationships).toHaveLength(context.foreignKeys.length);
    for (const relationship of semantic.relationships) {
      expect(relationship.cardinality).toBe("many-to-one");
      expect(
        semantic.tables[0].columns.some(
          (column) =>
            column.id === relationship.fromColumnId && column.role === "key",
        ),
      ).toBe(true);
      expect(
        semantic.tables.find((table) => table.id === relationship.toTableId)
          ?.keyColumnId,
      ).toBe(relationship.toColumnId);
    }
  });
  it("derives saved aggregations, counts, date intelligence, and evidence-backed coarse-to-fine hierarchies", () => {
    const semantic = deriveSemanticModel(input);
    expect(
      semantic.measures.find((measure) => measure.name === "Discount")
        ?.expression,
    ).toMatch(/^AVG/);
    expect(
      semantic.measures.some((measure) => measure.name === "Discount YTD"),
    ).toBe(false);
    expect(
      semantic.measures.find((measure) => measure.name === "Row Count")
        ?.expression,
    ).toBe("COUNT_BIG(*)");
    expect(
      semantic.measures.find((measure) => measure.name === "Distinct Order ID")
        ?.expression,
    ).toMatch(/^DISTINCTCOUNT/);
    expect(
      semantic.measures.find((measure) => measure.name === "Sales YoY %")
        ?.format,
    ).toBe("percent");
    const names = (id: string, levels: string[]) =>
      levels.map(
        (level) =>
          semantic.tables
            .find((table) => table.id === id)!
            .columns.find((column) => column.id === level)!.name,
      );
    const date = semantic.hierarchies.find(
      (hierarchy) => hierarchy.name === "Date",
    )!;
    expect(names(date.tableId, date.levels)).toEqual([
      "Year",
      "Quarter",
      "Month",
      "Date",
    ]);
    const product = semantic.hierarchies.find(
      (hierarchy) => hierarchy.name === "product",
    )!;
    expect(names(product.tableId, product.levels)).toEqual([
      "Category",
      "Product",
    ]);
    expect(
      deriveSemanticModel({ ...input, sampledRows: [] }).hierarchies,
    ).toHaveLength(1);
  });
  it("keeps hostile display names separate from sanitized quoted SQL identifiers", () => {
    const changed = structuredClone(input);
    changed.model.fact.name = "fact sales ']; DROP TABLE x; --";
    changed.model.fact.measures[0].name = "Sales ]' ;--";
    const semantic = deriveSemanticModel(changed);
    const measure = semantic.measures.find(
      (measure) =>
        measure.id ===
        `auto:measure:${changed.model.fact.measures[0].columnId}`,
    )!;
    expect(measure.expression).toContain("''");
    expect(measure.expression).toContain("]]");
    const result = compile(measure.expression, semantic);
    expect(result.sql).not.toContain("DROP TABLE");
    expect(result.sql).toContain("[dw].[fact_sales_drop_table_x]");
  });
});
