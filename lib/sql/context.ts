import type { SqlContext, SqlGenerationInput, PreparedColumn } from "./types";
import { sanitizeIdentifier, sqlType, uniqueIdentifier } from "./helpers";

export function buildSqlContext(input: SqlGenerationInput): SqlContext {
  const columns = new Map(
    input.columns.map((column) => [String(column.ordinal), column]),
  );
  if (columns.size !== input.columns.length)
    throw new Error("Source ordinals must be unique.");
  const stageTable = sanitizeIdentifier(
    input.project.sourceFile.replace(/\.(csv|xlsx)$/i, ""),
    "source",
  );
  const stageImportView = uniqueIdentifier(
    `${stageTable}_import`,
    new Set([stageTable]),
  );
  const stageNames = new Set(["source_row_number"]);
  const stageColumns = new Map(
    input.columns.map((column) => [
      String(column.ordinal),
      uniqueIdentifier(column.name, stageNames),
    ]),
  );
  const tableNames = new Set(["reject_rows"]);
  const factTable = uniqueIdentifier(input.model.fact.name, tableNames);
  const factNames = new Set([
    "run_id",
    "source_row_number",
    "created_at",
    "updated_at",
  ]);
  const factKey = uniqueIdentifier(`${factTable}_key`, factNames);
  const preparedColumn = (
    id: string,
    name: string,
    used: Set<string>,
  ): PreparedColumn => {
    const source = columns.get(id);
    if (!source)
      throw new Error(`The model references an unknown source column (${id}).`);
    return {
      id,
      source,
      name: uniqueIdentifier(name, used),
      type: sqlType(source),
    };
  };
  const dimensions = input.model.dimensions.map((model) => {
    const table = uniqueIdentifier(model.name, tableNames);
    const used = new Set(["created_at", "updated_at"]);
    const key =
      model.generated === "date"
        ? "DateKey"
        : uniqueIdentifier(`${table.replace(/^dim_/, "")}_key`, used);
    const dimensionColumns =
      model.generated === "date"
        ? []
        : model.columnIds.map((id) =>
            preparedColumn(
              id,
              input.model.columnNames[id] || columns.get(id)?.name || "column",
              used,
            ),
          );
    return {
      model,
      table,
      key,
      columns: dimensionColumns,
      businessKey:
        dimensionColumns.find((column) => column.id === model.businessKey) ??
        null,
    };
  });
  const foreignKeys = input.model.fact.foreignKeys.map((model) => {
    const dimension = dimensions.find(
      (candidate) => candidate.model.id === model.dimensionId,
    );
    if (!dimension)
      throw new Error("A foreign key references an unknown dimension.");
    const source =
      model.sourceColumnId === null ? null : columns.get(model.sourceColumnId);
    if (model.sourceColumnId !== null && !source)
      throw new Error("A foreign key references an unknown source column.");
    return {
      model,
      dimension,
      source: source ?? null,
      name: uniqueIdentifier(model.name, factNames),
    };
  });
  const measures = input.model.fact.measures.map((model) => ({
    ...preparedColumn(model.columnId, model.name, factNames),
    model,
  }));
  const degenerates = input.model.fact.degenerateDimensions.map((model) => ({
    ...preparedColumn(model.columnId, model.name, factNames),
    model,
  }));
  return {
    input,
    stageTable,
    stageImportView,
    factTable,
    factKey,
    stageColumns,
    columns,
    dimensions,
    foreignKeys,
    measures,
    degenerates,
    dateColumns: input.columns.filter(
      (column) => (column.overrideType ?? column.inferredType) === "date",
    ),
  };
}
