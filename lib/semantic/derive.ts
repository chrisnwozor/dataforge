import {
  functionalDependency,
  MAX_DEPENDENCY_PAIRS,
  MAX_DEPENDENCY_ROW_VISITS,
} from "@/lib/modeling/suggest";
import { buildSqlContext } from "@/lib/sql/context";
import { dateValue } from "@/lib/profiler/inference";
import type { Model } from "@/lib/modeling/types";
import type { SqlColumn, SqlGenerationInput } from "@/lib/sql/types";
import type {
  SemanticColumn,
  SemanticHierarchy,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
  SemanticType,
} from "./types";

export interface SemanticDerivationInput {
  project: SqlGenerationInput["project"];
  model: Model;
  columns: SqlColumn[];
  sampledRows?: (string | null)[][];
  updatedAt: string;
}

const type = (column: SqlColumn): SemanticType => {
  const effective = column.overrideType ?? column.inferredType;
  return effective === "integer" || effective === "decimal"
    ? "number"
    : effective === "text"
      ? "string"
      : effective;
};
const bracket = (value: string) => `[${value.replaceAll("]", "]]")}]`;
const tableRef = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Bounds come from retained profiles; metadata never issues a distinct-value query. */
function calendarCardinality(name: string, sources: SqlColumn[]): { distinctCount?: number } {
  const bounded: Record<string, number> = {
    Quarter: 4, QuarterName: 4, Month: 12, MonthName: 12,
    Day: 31, DayOfWeek: 7, DayName: 7, WeekOfYear: 53, IsWeekend: 2,
  };
  if (bounded[name] !== undefined) return { distinctCount: bounded[name] };
  const minima = sources.flatMap((column) => {
    const value = column.minValue && dateValue(column.minValue);
    return typeof value === "number" ? [value] : [];
  });
  const maxima = sources.flatMap((column) => {
    const value = column.maxValue && dateValue(column.maxValue);
    return typeof value === "number" ? [value] : [];
  });
  if (!minima.length || !maxima.length) return {};
  const start = new Date(Math.min(...minima));
  const end = new Date(Math.max(...maxima));
  start.setUTCHours(0, 0, 0, 0); end.setUTCHours(0, 0, 0, 0);
  if (start.getUTCFullYear() > 1) start.setUTCFullYear(start.getUTCFullYear() - 1);
  else { start.setUTCMonth(0, 1); }
  if (end.getUTCFullYear() < 9999) end.setUTCFullYear(end.getUTCFullYear() + 1);
  else { end.setUTCMonth(11, 31); }
  return name === "Year"
    ? { distinctCount: end.getUTCFullYear() - start.getUTCFullYear() + 1 }
    : name === "Date" ? { distinctCount: Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1 } : {};
}

/** Derive metadata from exactly the same prepared SQL names used by the generator. No I/O. */
export function deriveSemanticModel(
  input: SemanticDerivationInput,
): SemanticModel {
  const context = buildSqlContext({
    ...input,
    options: {
      incremental: false,
      dedupe: input.model.removeExactDuplicates,
      database: "DataForge",
      generatedAt: "semantic",
    },
  });
  const fact: SemanticTable = {
    id: "fact",
    name: input.model.fact.name,
    schema: "dw",
    sqlName: context.factTable,
    kind: "fact",
    keyColumnId: "fact:key",
    columns: [],
  };
  fact.columns.push({
    id: fact.keyColumnId,
    tableId: fact.id,
    name: context.factKey,
    sqlName: context.factKey,
    type: "number",
    role: "key",
  });
  for (const measure of context.measures)
    fact.columns.push({
      id: `fact:measure:${measure.id}`,
      tableId: fact.id,
      name: measure.model.name,
      sqlName: measure.name,
      type: type(measure.source),
      role: "measure-source",
      sourceColumnId: measure.id,
    });
  for (const dimension of context.degenerates)
    fact.columns.push({
      id: `fact:degenerate:${dimension.id}`,
      tableId: fact.id,
      name: dimension.model.name,
      sqlName: dimension.name,
      type: type(dimension.source),
      role: "attribute",
      sourceColumnId: dimension.id,
      distinctCount: dimension.source.distinctCount,
    });
  const dimensions: SemanticTable[] = context.dimensions.map((dimension) => {
    const id = dimension.model.id;
    const columns: SemanticColumn[] = [
      {
        id: `${id}:key`,
        tableId: id,
        name: dimension.key,
        sqlName: dimension.key,
        type: "number",
        role: "key",
      },
    ];
    if (dimension.model.generated === "date") {
      for (const [name, columnType] of [
        ["Date", "date"],
        ["Year", "number"],
        ["Quarter", "number"],
        ["QuarterName", "string"],
        ["Month", "number"],
        ["MonthName", "string"],
        ["Day", "number"],
        ["DayOfWeek", "number"],
        ["DayName", "string"],
        ["WeekOfYear", "number"],
        ["IsWeekend", "boolean"],
      ] as const)
        columns.push({
          id: `${id}:${name}`,
          tableId: id,
          name,
          sqlName: name,
          type: columnType,
          role: "attribute",
          ...calendarCardinality(name, context.dateColumns),
        });
    } else
      for (const column of dimension.columns)
        columns.push({
          id: `${id}:column:${column.id}`,
          tableId: id,
          name: input.model.columnNames[column.id] || column.source.name,
          sqlName: column.name,
          type: type(column.source),
          role: "attribute",
          sourceColumnId: column.id,
          distinctCount: column.source.distinctCount,
        });
    return {
      id,
      name: dimension.model.name,
      schema: "dw",
      sqlName: dimension.table,
      kind: "dimension",
      keyColumnId: `${id}:key`,
      columns,
    };
  });
  const relationships = context.foreignKeys.map((key, ordinal) => {
    const id = `fact:fk:${ordinal}`;
    fact.columns.push({
      id,
      tableId: fact.id,
      name: key.model.name,
      sqlName: key.name,
      type: "number",
      role: "key",
      ...(key.model.sourceColumnId === null
        ? {}
        : { sourceColumnId: key.model.sourceColumnId }),
    });
    return {
      id: `relationship:${ordinal}`,
      fromTableId: fact.id,
      fromColumnId: id,
      toTableId: key.dimension.model.id,
      toColumnId: `${key.dimension.model.id}:key`,
      cardinality: "many-to-one" as const,
    };
  });
  const dateRelationship = context.foreignKeys.findIndex(
    (key) => key.dimension.model.generated === "date",
  );
  const dateTable =
    dateRelationship < 0
      ? undefined
      : dimensions.find(
          (table) =>
            table.id ===
            context.foreignKeys[dateRelationship].dimension.model.id,
        );
  const measures: SemanticMeasure[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (preferred: string) => {
    let candidate = preferred.slice(0, 128);
    let ordinal = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      const suffix = ` (${ordinal++})`;
      candidate = preferred.slice(0, 128 - suffix.length) + suffix;
    }
    usedNames.add(candidate.toLowerCase());
    return candidate;
  };
  const add = (
    id: string,
    name: string,
    expression: string,
    folder: string,
    description: string,
    format: SemanticMeasure["format"] = "number",
  ) => {
    const measure = {
      id,
      name: uniqueName(name),
      expression,
      folder,
      description,
      format,
      isAuto: true,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    };
    measures.push(measure);
    return measure;
  };
  for (const source of context.measures) {
    const base = add(
      `auto:measure:${source.id}`,
      source.model.name,
      `${source.model.aggregation}(${tableRef(fact.name)}${bracket(source.model.name)})`,
      "Measures",
      source.model.reason,
      source.model.aggregation === "AVG" ? "decimals" : "number",
    );
    if (dateTable && source.model.aggregation === "SUM") {
      const ref = bracket(base.name);
      for (const fn of ["YTD", "MTD", "QTD"] as const)
        add(
          `${base.id}:${fn}`,
          `${base.name} ${fn}`,
          `${fn}(${ref})`,
          "Time intelligence",
          `${fn} of ${base.name} through the current date context.`,
        );
      const lastYear = add(
        `${base.id}:LY`,
        `${base.name} LY`,
        `SAMEPERIODLASTYEAR(${ref})`,
        "Time intelligence",
        `The same date interval one year earlier for ${base.name}.`,
      );
      add(
        `${base.id}:YoY`,
        `${base.name} YoY %`,
        `DIVIDE(${ref} - ${bracket(lastYear.name)}, ${bracket(lastYear.name)})`,
        "Time intelligence",
        `Change from the same period last year for ${base.name}.`,
        "percent",
      );
    }
  }
  add(
    "auto:row-count",
    "Row Count",
    "COUNT_BIG(*)",
    "Counts",
    "Number of fact rows in the current filter context.",
  );
  for (const source of context.degenerates)
    add(
      `auto:distinct:${source.id}`,
      `Distinct ${source.model.name}`,
      `DISTINCTCOUNT(${tableRef(fact.name)}${bracket(source.model.name)})`,
      "Counts",
      `Distinct non-null ${source.model.name} values in the current context.`,
    );
  const hierarchies: SemanticHierarchy[] = [];
  if (dateTable)
    hierarchies.push({
      id: `auto:hierarchy:${dateTable.id}`,
      name: "Date",
      tableId: dateTable.id,
      levels: ["Year", "Quarter", "Month", "Date"].map(
        (name) => `${dateTable.id}:${name}`,
      ),
      isAuto: true,
    });
  let remainingPairs = MAX_DEPENDENCY_PAIRS;
  let remainingRowVisits = MAX_DEPENDENCY_ROW_VISITS;
  const sampledRows = input.sampledRows ?? [];
  for (const dimension of context.dimensions.filter(
    (value) => value.model.generated !== "date",
  )) {
    const candidates = dimension.columns
      .filter((column) => type(column.source) === "string")
      .sort(
        (a, b) =>
          a.source.distinctCount - b.source.distinctCount ||
          a.source.ordinal - b.source.ordinal,
      );
    // A hierarchy moves from coarse to fine. Each finer level must determine its parent.
    const levels: typeof candidates = [];
    for (const candidate of candidates) {
      const parent = levels.at(-1);
      if (!parent) {
        levels.push(candidate);
        continue;
      }
      if (
        levels.length >= 12 ||
        remainingPairs < 1 ||
        remainingRowVisits < sampledRows.length
      )
        break;
      remainingPairs--;
      remainingRowVisits -= sampledRows.length;
      const evidence = functionalDependency(
        sampledRows,
        candidate.source.ordinal,
        parent.source.ordinal,
      );
      if (
        candidate.source.distinctCount > parent.source.distinctCount &&
        evidence.holds &&
        evidence.repeatedDeterminants
      )
        levels.push(candidate);
    }
    if (levels.length > 1)
      hierarchies.push({
        id: `auto:hierarchy:${dimension.model.id}`,
        name: dimension.model.name.replace(/^dim_/, "").replaceAll("_", " "),
        tableId: dimension.model.id,
        levels: levels.map(
          (column) => `${dimension.model.id}:column:${column.id}`,
        ),
        isAuto: true,
      });
  }
  return {
    projectId: input.project.id,
    version: "derived",
    factTableId: fact.id,
    tables: [fact, ...dimensions],
    relationships,
    measures,
    hierarchies,
    ...(dateTable
      ? {
          date: {
            tableId: dateTable.id,
            dateColumnId: `${dateTable.id}:Date`,
            keyColumnId: dateTable.keyColumnId,
            factColumnId: `fact:fk:${dateRelationship}`,
          },
        }
      : {}),
  };
}
