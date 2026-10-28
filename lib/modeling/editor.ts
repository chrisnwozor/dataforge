import type { ColumnProfile } from "@/lib/types";
import type { Aggregation, Dimension, ForeignKey, Model } from "./types";

export type ModelAction =
  | { type: "replace"; model: Model }
  | {
      type: "move";
      column: string;
      target: string;
      columnType: ColumnProfile["type"];
    }
  | { type: "add"; id: string }
  | { type: "rename"; id: string; name: string }
  | { type: "rename-column"; column: string; name: string }
  | { type: "grain"; value: string }
  | { type: "key"; id: string; column: string }
  | { type: "remove"; id: string }
  | { type: "aggregation"; column: string; aggregation: Aggregation }
  | { type: "duplicates"; value: boolean }
  | { type: "columnstore"; value: boolean };

function keyName(name: string): string {
  return (
    name
      .replace(/^dim_/, "")
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join("") || "Dimension"
  );
}

function foreignKeyName(name: string): string {
  return `${keyName(name).slice(0, 125)}Key`;
}

/** Foreign keys reference dimensions; they do not own a second copy of a source column. */
function synchronizeForeignKeys(model: Model): Model {
  const foreignKeys: ForeignKey[] = [];
  const names = new Set<string>();
  const add = (key: ForeignKey) => {
    const base = key.name.slice(0, 128);
    let name = base;
    let suffix = 2;
    while (names.has(name)) {
      const ending = `_${suffix++}`;
      name = `${base.slice(0, 128 - ending.length)}${ending}`;
    }
    names.add(name);
    foreignKeys.push({ ...key, name });
  };
  for (const dimension of model.dimensions) {
    if (dimension.generated === "date") {
      for (const columnId of dimension.columnIds) {
        const existing = model.fact.foreignKeys.find(
          (key) =>
            key.dimensionId === dimension.id && key.sourceColumnId === columnId,
        );
        add({
          name:
            existing?.name ??
            (dimension.columnIds.length === 1
              ? "DateKey"
              : foreignKeyName(model.columnNames[columnId] ?? "Date")),
          dimensionId: dimension.id,
          sourceColumnId: columnId,
          reason:
            existing?.reason ??
            "Links the source date to the generated calendar.",
        });
      }
    } else {
      const existing = model.fact.foreignKeys.find(
        (key) => key.dimensionId === dimension.id,
      );
      add({
        name: existing?.name ?? foreignKeyName(dimension.name),
        dimensionId: dimension.id,
        sourceColumnId: dimension.businessKey || null,
        reason: existing?.reason ?? "Links the fact to this dimension.",
      });
    }
  }
  return { ...model, fact: { ...model.fact, foreignKeys } };
}

function removeColumn(dimension: Dimension, column: string): Dimension {
  const columnIds = dimension.columnIds.filter((id) => id !== column);
  const businessKey =
    dimension.generated === "date" || dimension.businessKey !== column
      ? dimension.businessKey
      : "";
  return {
    ...dimension,
    columnIds,
    businessKey,
    attributes:
      dimension.generated === "date"
        ? dimension.attributes
        : columnIds.filter((id) => id !== businessKey),
  };
}

/** Edits retain source ordinals so a renamed column still refers to its profile. */
export function modelReducer(state: Model, action: ModelAction): Model {
  switch (action.type) {
    case "replace":
      return structuredClone(action.model);
    case "columnstore":
      return { ...state, columnstore: action.value };
    case "move": {
      if (!Object.hasOwn(state.columnNames, action.column)) return state;
      const target = state.dimensions.find((d) => d.id === action.target);
      if (!target && action.target !== "fact" && action.target !== "unassigned")
        return state;
      if (target?.generated === "date" && action.columnType !== "DATE")
        return state;
      if (
        (action.target === "fact" &&
          (state.fact.measures.some((m) => m.columnId === action.column) ||
            state.fact.degenerateDimensions.some(
              (d) => d.columnId === action.column,
            ))) ||
        (action.target === "unassigned" &&
          state.unassigned.includes(action.column)) ||
        target?.columnIds.includes(action.column)
      )
        return state;

      const next: Model = {
        ...state,
        fact: {
          ...state.fact,
          measures: state.fact.measures.filter(
            (measure) => measure.columnId !== action.column,
          ),
          degenerateDimensions: state.fact.degenerateDimensions.filter(
            (dimension) => dimension.columnId !== action.column,
          ),
        },
        dimensions: state.dimensions.map((dimension) =>
          removeColumn(dimension, action.column),
        ),
        unassigned: state.unassigned.filter((id) => id !== action.column),
        reasons: {
          ...state.reasons,
          [action.column]: "Assigned manually in the model editor.",
        },
      };
      if (action.target === "fact") {
        const name = state.columnNames[action.column];
        if (action.columnType === "INT" || action.columnType === "DECIMAL") {
          const nonAdditive = /discount|rate|pct|ratio|price/i.test(name);
          next.fact.measures.push({
            columnId: action.column,
            name,
            aggregation: nonAdditive ? "AVG" : "SUM",
            additivity: nonAdditive ? "non-additive" : "additive",
            reason: "Assigned as a measure in the model editor.",
          });
        } else {
          next.fact.degenerateDimensions.push({
            columnId: action.column,
            name,
            reason: "Assigned as an identifier in the model editor.",
          });
        }
      } else if (action.target === "unassigned") {
        next.unassigned.push(action.column);
      } else {
        next.dimensions = next.dimensions.map((dimension) => {
          if (dimension.id !== action.target) return dimension;
          const columnIds = [...dimension.columnIds, action.column];
          const businessKey =
            dimension.generated === "date"
              ? "DateKey"
              : dimension.businessKey || action.column;
          return {
            ...dimension,
            columnIds,
            businessKey,
            attributes:
              dimension.generated === "date"
                ? dimension.attributes
                : columnIds.filter((id) => id !== businessKey),
          };
        });
      }
      return synchronizeForeignKeys(next);
    }
    case "add": {
      if (
        state.dimensions.some((dimension) => dimension.id === action.id) ||
        action.id === "fact" ||
        action.id === "unassigned"
      )
        return state;
      const names = new Set([
        state.fact.name.toLowerCase(),
        ...state.dimensions.map((dimension) => dimension.name.toLowerCase()),
      ]);
      let suffix = state.dimensions.length + 1;
      while (names.has(`dim_custom_${suffix}`)) suffix++;
      return synchronizeForeignKeys({
        ...state,
        dimensions: [
          ...state.dimensions,
          {
            id: action.id,
            name: `dim_custom_${suffix}`,
            columnIds: [],
            attributes: [],
            businessKey: "",
            generated: null,
            reason: "Added in the model editor.",
          },
        ],
      });
    }
    case "rename": {
      const name = action.name.trim();
      if (!name) return state;
      if (action.id === "fact")
        return { ...state, fact: { ...state.fact, name } };
      if (!state.dimensions.some((dimension) => dimension.id === action.id))
        return state;
      return synchronizeForeignKeys({
        ...state,
        dimensions: state.dimensions.map((dimension) =>
          dimension.id === action.id ? { ...dimension, name } : dimension,
        ),
        fact: {
          ...state.fact,
          foreignKeys: state.fact.foreignKeys.map((key) =>
            key.dimensionId === action.id &&
            state.dimensions.find((dimension) => dimension.id === action.id)
              ?.generated !== "date"
              ? { ...key, name: foreignKeyName(name) }
              : key,
          ),
        },
      });
    }
    case "rename-column": {
      const name = action.name.trim();
      if (!name || !Object.hasOwn(state.columnNames, action.column))
        return state;
      return {
        ...state,
        columnNames: { ...state.columnNames, [action.column]: name },
        fact: {
          ...state.fact,
          measures: state.fact.measures.map((measure) =>
            measure.columnId === action.column ? { ...measure, name } : measure,
          ),
          degenerateDimensions: state.fact.degenerateDimensions.map(
            (dimension) =>
              dimension.columnId === action.column
                ? { ...dimension, name }
                : dimension,
          ),
        },
      };
    }
    case "grain":
      return { ...state, fact: { ...state.fact, grain: action.value } };
    case "key": {
      const dimension = state.dimensions.find((d) => d.id === action.id);
      if (
        !dimension ||
        dimension.generated === "date" ||
        (action.column !== "" && !dimension.columnIds.includes(action.column))
      )
        return state;
      return synchronizeForeignKeys({
        ...state,
        dimensions: state.dimensions.map((d) =>
          d.id === action.id
            ? {
                ...d,
                businessKey: action.column,
                attributes: d.columnIds.filter((id) => id !== action.column),
              }
            : d,
        ),
      });
    }
    case "remove": {
      const dimension = state.dimensions.find((d) => d.id === action.id);
      if (!dimension) return state;
      return synchronizeForeignKeys({
        ...state,
        dimensions: state.dimensions.filter((d) => d.id !== action.id),
        unassigned: [...new Set([...state.unassigned, ...dimension.columnIds])],
      });
    }
    case "aggregation":
      return {
        ...state,
        fact: {
          ...state.fact,
          measures: state.fact.measures.map((measure) =>
            measure.columnId === action.column
              ? { ...measure, aggregation: action.aggregation }
              : measure,
          ),
        },
      };
    case "duplicates":
      return { ...state, removeExactDuplicates: action.value };
  }
}
