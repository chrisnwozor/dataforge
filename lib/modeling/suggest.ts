import type {
  Dimension,
  ForeignKey,
  Model,
  SuggestionColumn,
  SuggestionInput,
} from "./types";

export interface FunctionalDependency {
  holds: boolean;
  confidence: number;
  evaluatedRows: number;
  violatingRows: number;
  determinantValues: number;
  repeatedDeterminants: boolean;
}

/** Bound work for very wide datasets; skipped relationships remain separate dimensions. */
export const MAX_DEPENDENCY_PAIRS = 20_000;
export const MAX_DEPENDENCY_ROW_VISITS = 5_000_000;

/**
 * A value's modal dependent value is its mapping. Count other rows as violations,
 * not whole groups; null determinants supply no evidence and null dependents do.
 */
export function functionalDependency(
  rows: readonly (readonly (string | null)[])[],
  determinantOrdinal: number,
  dependentOrdinal: number,
): FunctionalDependency {
  const mappings = new Map<string, Map<string | null, number>>();
  let evaluatedRows = 0;
  for (const row of rows) {
    const determinant = row[determinantOrdinal];
    if (
      determinant === null ||
      determinant === undefined ||
      determinant.trim() === ""
    )
      continue;
    const rawDependent = row[dependentOrdinal];
    const dependent =
      rawDependent === undefined ||
      rawDependent === null ||
      rawDependent.trim() === ""
        ? null
        : rawDependent.trim();
    const key = determinant.trim();
    const counts = mappings.get(key) ?? new Map<string | null, number>();
    counts.set(dependent, (counts.get(dependent) ?? 0) + 1);
    mappings.set(key, counts);
    evaluatedRows++;
  }
  let matchingRows = 0;
  let repeatedDeterminants = false;
  for (const counts of mappings.values()) {
    let maximum = 0;
    let total = 0;
    for (const count of counts.values()) {
      maximum = Math.max(maximum, count);
      total += count;
    }
    if (total > 1) repeatedDeterminants = true;
    matchingRows += maximum;
  }
  const violatingRows = evaluatedRows - matchingRows;
  return {
    // Integer arithmetic makes the inclusive one-percent boundary deterministic.
    holds: evaluatedRows > 0 && violatingRows * 100 <= evaluatedRows,
    confidence: evaluatedRows ? matchingRows / evaluatedRows : 0,
    evaluatedRows,
    violatingRows,
    determinantValues: mappings.size,
    repeatedDeterminants,
  };
}

function words(value: string): string[] {
  return value
    .slice(0, 1_024)
    .replace(/\.(csv|xlsx)$/i, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function slug(value: string, fallback = "data"): string {
  return words(value).join("_") || fallback;
}

function pascal(value: string): string {
  return words(value)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
}

function dimensionName(column: SuggestionColumn): string {
  const parts = words(column.name).filter(
    (part) => !["name", "label", "description"].includes(part),
  );
  return `dim_${parts.join("_") || slug(column.name, `column_${column.ordinal + 1}`)}`.slice(
    0,
    128,
  );
}

function isIdLike(column: SuggestionColumn): boolean {
  return (
    column.isKeyCandidate ||
    /(id|key|code|number)$/i.test(column.name.replace(/[^a-z0-9]/gi, ""))
  );
}

function determinantPreference(column: SuggestionColumn): number {
  const name = column.name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ")
    .toLowerCase();
  // Resolve one-to-one repeating labels deterministically, preferring explicit keys.
  if (/\b(id|key|code|number)\b/.test(name)) return 4;
  if (/\b(name|product|customer|client|applicant)\b/.test(name)) return 3;
  if (/\b(category|segment|type|region)\b/.test(name)) return 1;
  return 2;
}

function countObservedValues(
  rows: SuggestionInput["sampledRows"],
  ordinal: number,
): number {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[ordinal];
    if (value !== null && value !== undefined && value.trim())
      values.add(value.trim());
  }
  return values.size;
}

/** Rules-only suggestion: deterministic output, no filesystem, network, clock, or database. */
export function suggestModel(input: SuggestionInput): Model {
  const columns = input.columns
    .map((column) => ({
      ...column,
      name: column.name.slice(0, 128),
      // Classify the full source header before bounding its editable SQL alias.
      idLike: isIdLike(column),
      nonAdditive: /discount|rate|pct|ratio|price/i.test(column.name),
      transactionId: /order|invoice|transaction|id/i.test(column.name),
      determinantPreference: determinantPreference(column),
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
  const topic =
    words(input.topic)
      .filter(
        (part) => !["superstore", "sample", "dataset", "data"].includes(part),
      )
      .join("_") || "data";
  const model: Model = {
    fact: {
      name: `fact_${topic}`.slice(0, 128),
      grain: "",
      reason:
        "One fact table keeps the source dataset's row-level observations together.",
      measures: [],
      foreignKeys: [],
      degenerateDimensions: [],
    },
    dimensions: [],
    unassigned: [],
    columnNames: Object.fromEntries(
      columns.map((column) => [column.id, column.name]),
    ),
    reasons: {},
    removeExactDuplicates: false,
    columnstore: true,
    warnings: [],
  };
  const usedTableNames = new Set([model.fact.name]);
  const uniqueName = (candidate: string) => {
    let name = candidate;
    let suffix = 2;
    while (usedTableNames.has(name)) {
      const ending = `_${suffix++}`;
      name = `${candidate.slice(0, 128 - ending.length)}${ending}`;
    }
    usedTableNames.add(name);
    return name;
  };

  const dates = columns.filter((column) => column.type === "date");
  if (dates.length) {
    const reason =
      "Date columns share a generated calendar dimension with DateKey, date, year, quarter, month, and day attributes.";
    const calendar: Dimension = {
      id: "date",
      name: uniqueName("dim_date"),
      businessKey: "DateKey",
      columnIds: dates.map((column) => column.id),
      attributes: ["DateKey", "Date", "Year", "Quarter", "Month", "Day"],
      generated: "date",
      reason,
    };
    model.dimensions.push(calendar);
    for (const column of dates) {
      model.reasons[column.id] =
        `${column.name} is a date and links to the generated calendar.`;
      model.fact.foreignKeys.push({
        name:
          dates.length === 1
            ? "DateKey"
            : `${pascal(column.name).slice(0, 125)}Key`,
        dimensionId: calendar.id,
        sourceColumnId: column.id,
        reason: model.reasons[column.id],
      });
    }
  }

  const remaining: (typeof columns)[number][] = [];
  for (const column of columns) {
    if (column.type === "date") continue;
    if (
      (column.type === "integer" || column.type === "decimal") &&
      !column.idLike
    ) {
      const nonAdditive = column.nonAdditive;
      const reason = nonAdditive
        ? `${column.name} is a numeric rate or unit value; average it instead of summing it.`
        : `${column.name} is numeric and is not an ID or key; sum is the default aggregation.`;
      model.fact.measures.push({
        columnId: column.id,
        name: column.name,
        aggregation: nonAdditive ? "AVG" : "SUM",
        additivity: nonAdditive ? "non-additive" : "additive",
        reason,
      });
      model.reasons[column.id] = reason;
    } else if (
      column.type === "text" &&
      (column.isKeyCandidate || column.isNearKeyCandidate) &&
      column.transactionId
    ) {
      const reason = `${column.name} is a ${column.isKeyCandidate ? "unique" : "near-unique"} transaction identifier; keep it on the fact as a degenerate dimension.`;
      model.fact.degenerateDimensions.push({
        columnId: column.id,
        name: column.name,
        reason,
      });
      model.reasons[column.id] = reason;
    } else remaining.push(column);
  }

  const text = remaining.filter((column) => column.type === "text");
  const observed = new Map(
    text.map((column) => [
      column.id,
      countObservedValues(input.sampledRows, column.ordinal),
    ]),
  );
  const orderedDeterminants = [...text].sort(
    (a, b) =>
      b.distinctCount - a.distinctCount ||
      b.determinantPreference - a.determinantPreference ||
      a.ordinal - b.ordinal,
  );
  const claimed = new Set<string>();
  const addDimension = (
    key: SuggestionColumn,
    attributes: SuggestionColumn[],
    reason: string,
  ) => {
    const dimension: Dimension = {
      id: `column-${key.id}`,
      name: uniqueName(dimensionName(key)),
      businessKey: key.id,
      columnIds: [key.id, ...attributes.map((column) => column.id)],
      attributes: attributes.map((column) => column.id),
      generated: null,
      reason,
    };
    model.dimensions.push(dimension);
    const foreignKey: ForeignKey = {
      name: `${pascal(dimension.name.replace(/^dim_/, "")).slice(0, 125)}Key`,
      dimensionId: dimension.id,
      sourceColumnId: key.id,
      reason: `${dimension.name} stores descriptive values identified by ${key.name}.`,
    };
    model.fact.foreignKeys.push(foreignKey);
    claimed.add(key.id);
    model.reasons[key.id] = reason;
    for (const attribute of attributes) claimed.add(attribute.id);
  };

  let pairVisits = 0;
  let rowVisits = 0;
  let dependenciesTruncated = false;
  determinants: for (const determinant of orderedDeterminants) {
    if (claimed.has(determinant.id)) continue;
    const attributes: (typeof columns)[number][] = [];
    const explanations: string[] = [];
    for (const dependent of text) {
      if (++pairVisits > MAX_DEPENDENCY_PAIRS) {
        dependenciesTruncated = true;
        break;
      }
      if (dependent.id === determinant.id || claimed.has(dependent.id))
        continue;
      const determinantCount = observed.get(determinant.id) ?? 0;
      const dependentCount = observed.get(dependent.id) ?? 0;
      if (
        determinantCount < 2 ||
        dependentCount < 1 ||
        determinantCount < dependentCount
      )
        continue;
      if (
        determinantCount === dependentCount &&
        (determinant.determinantPreference < dependent.determinantPreference ||
          (determinant.determinantPreference ===
            dependent.determinantPreference &&
            determinant.ordinal > dependent.ordinal))
      )
        continue;
      if (rowVisits + input.sampledRows.length > MAX_DEPENDENCY_ROW_VISITS) {
        dependenciesTruncated = true;
        break;
      }
      rowVisits += input.sampledRows.length;
      const dependency = functionalDependency(
        input.sampledRows,
        determinant.ordinal,
        dependent.ordinal,
      );
      if (!dependency.holds || !dependency.repeatedDeterminants) continue;
      const scope =
        input.sampledRows.length < input.rowCount ? "sampled rows" : "rows";
      const reason = `${determinant.name} determines ${dependent.name} in ${(dependency.confidence * 100).toFixed(1)}% of ${dependency.evaluatedRows.toLocaleString("en-US")} ${scope}.`;
      attributes.push(dependent);
      explanations.push(reason);
      model.reasons[dependent.id] = reason;
    }
    if (attributes.length)
      addDimension(
        determinant,
        attributes,
        explanations.join(" ").slice(0, 2_000),
      );
    if (dependenciesTruncated) break determinants;
  }
  for (const column of remaining) {
    if (claimed.has(column.id)) continue;
    const reason = `${column.name} has no supported dependency on another descriptive column; keep it in its own dimension.`;
    addDimension(column, [], reason);
  }
  const grainColumns = model.fact.degenerateDimensions.length
    ? model.fact.degenerateDimensions.map((column) => column.name)
    : model.dimensions.map((dimension) =>
        dimension.generated === "date"
          ? dates.map((column) => column.name).join(" and ")
          : model.columnNames[dimension.businessKey],
      );
  model.fact.grain = (
    grainColumns.length
      ? `one row per ${grainColumns.join(" and ")}`
      : "one row per source observation"
  ).slice(0, 2_000);
  if (dependenciesTruncated)
    model.warnings.push(
      "Functional dependency analysis reached its bounded work budget (20,000 candidate pairs or 5,000,000 sampled row visits). Unchecked columns remain separate dimensions; review and group them manually.",
    );
  if (input.duplicateRowCount > 0)
    model.warnings.push(
      `${input.duplicateRowCount.toLocaleString("en-US")} fully duplicated ${input.duplicateRowCount === 1 ? "row was" : "rows were"} found. Enable remove exact duplicates if those repeated observations should be excluded.`,
    );
  if (input.sampledRows.length < input.rowCount)
    model.warnings.push(
      `Functional dependencies use ${input.sampledRows.length.toLocaleString("en-US")} sampled rows out of ${input.rowCount.toLocaleString("en-US")}; review these suggestions against the complete source.`,
    );
  return model;
}
