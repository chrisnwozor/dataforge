import type { Model, ModelValidationIssue } from "./types";

/** Validate a draft without rewriting or dropping any of the user's assignments. */
export function validateModel(
  model: Model,
  columns: readonly { id: string; name: string }[],
): ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];
  const add = (
    code: string,
    message: string,
    severity: ModelValidationIssue["severity"] = "error",
  ) => issues.push({ severity, code, message });
  const known = new Map(columns.map((column) => [column.id, column.name]));
  const assignments = new Map<string, string[]>();
  const assign = (id: string, table: string) => {
    if (!known.has(id)) {
      add(
        "unknown-column",
        `${table} references a removed or unknown source column: ${model.columnNames[id] || id}. Repair this assignment after preparation.`,
      );
      return;
    }
    const locations = assignments.get(id) ?? [];
    locations.push(table);
    assignments.set(id, locations);
  };

  if (!model.fact.measures.length)
    add("no-measures", "The fact table has no measures.");
  if (!model.fact.grain.trim())
    add("missing-grain", "Set the fact table grain.");

  const tableNames = new Set<string>();
  for (const name of [
    model.fact.name,
    ...model.dimensions.map((d) => d.name),
  ]) {
    const normalized = name.trim().toLowerCase();
    if (!normalized) add("missing-table-name", "Every table needs a name.");
    else if (tableNames.has(normalized))
      add(
        "duplicate-table-name",
        `The table name ${name} is used more than once.`,
      );
    tableNames.add(normalized);
  }
  model.fact.measures.forEach((measure) =>
    assign(measure.columnId, model.fact.name),
  );
  model.fact.degenerateDimensions.forEach((column) =>
    assign(column.columnId, model.fact.name),
  );

  const dimensionIds = new Set<string>();
  for (const dimension of model.dimensions) {
    if (dimensionIds.has(dimension.id))
      add(
        "duplicate-dimension-id",
        `The dimension ID ${dimension.id} is used more than once.`,
      );
    dimensionIds.add(dimension.id);
    if (!dimension.businessKey.trim())
      add(
        "missing-business-key",
        `${dimension.name || "A dimension"} needs a business key.`,
      );
    else if (
      dimension.generated !== "date" &&
      !dimension.columnIds.includes(dimension.businessKey)
    )
      add(
        "invalid-business-key",
        `${dimension.name}'s business key must be one of its source columns.`,
      );
    else if (
      dimension.generated === "date" &&
      dimension.businessKey !== "DateKey"
    )
      add(
        "invalid-business-key",
        "The calendar dimension uses the generated DateKey business key.",
      );
    dimension.columnIds.forEach((id) => assign(id, dimension.name));
    if (dimension.generated !== "date") {
      const expected = dimension.columnIds.filter(
        (id) => id !== dimension.businessKey,
      );
      if (
        dimension.attributes.some((id) => !expected.includes(id)) ||
        expected.some((id) => !dimension.attributes.includes(id)) ||
        new Set(dimension.attributes).size !== dimension.attributes.length
      )
        add(
          "invalid-attributes",
          `${dimension.name}'s attributes must match its source columns other than the business key.`,
        );
    }
  }

  for (const foreignKey of model.fact.foreignKeys) {
    if (!dimensionIds.has(foreignKey.dimensionId))
      add(
        "unknown-dimension",
        `${foreignKey.name} references a dimension that does not exist.`,
      );
    if (
      foreignKey.sourceColumnId !== null &&
      !known.has(foreignKey.sourceColumnId)
    )
      add(
        "unknown-column",
        `${foreignKey.name} references a removed or unknown source column: ${model.columnNames[foreignKey.sourceColumnId] || foreignKey.sourceColumnId}.`,
      );
  }
  const explicitlyUnassigned = new Set(model.unassigned);
  if (explicitlyUnassigned.size !== model.unassigned.length)
    add(
      "duplicate-assignment",
      "A source column appears more than once in unassigned columns.",
    );
  for (const id of model.unassigned) {
    if (!known.has(id))
      add(
        "unknown-column",
        `Unassigned references a removed or unknown source column: ${model.columnNames[id] || id}.`,
      );
    if (assignments.has(id))
      add(
        "duplicate-assignment",
        `${known.get(id) ?? id} is both assigned to a table and unassigned.`,
      );
  }
  for (const [id, locations] of assignments) {
    if (locations.length > 1)
      add(
        "duplicate-assignment",
        `${known.get(id)} is assigned more than once (${locations.join(", ")}).`,
      );
  }
  const unassigned = columns.filter(
    (column) =>
      explicitlyUnassigned.has(column.id) || !assignments.has(column.id),
  );
  if (unassigned.length)
    add(
      "unassigned-columns",
      `${unassigned.length} source ${unassigned.length === 1 ? "column is" : "columns are"} unassigned: ${unassigned.map((column) => model.columnNames[column.id] || column.name).join(", ")}.`,
      "warning",
    );
  for (const warning of model.warnings) {
    if (
      model.removeExactDuplicates &&
      /\bduplicat(?:e|ed|es)\b/i.test(warning)
    ) {
      const count = warning.match(
        /([\d,]+)\s+(?:fully\s+)?duplicat(?:e|ed)\s+rows?\b/i,
      )?.[1];
      add(
        "duplicates-removed",
        count
          ? `${count} duplicate ${count === "1" ? "row will" : "rows will"} be removed during the load.`
          : "Exact duplicate rows will be removed during the load.",
        "info",
      );
    } else add("suggestion-warning", warning, "warning");
  }
  return issues;
}
