import type { Model } from "@/lib/modeling/types";

/** Preserve edits by source name, while retaining removed references as visible draft errors. */
export function reconcilePreparedModel(input: Model, oldColumns: readonly { ordinal: number; name: string }[], nextColumns: readonly { ordinal: number; name: string }[], previousMissing: Record<string, string> = {}): { model: Model; missing: Record<string, string> } {
  const model = structuredClone(input);
  const sourceNames = new Map([...oldColumns.map((column) => [String(column.ordinal), column.name] as const), ...Object.entries(previousMissing)]);
  const nextIds = new Map(nextColumns.map((column) => [column.name, String(column.ordinal)]));
  const mapping = new Map<string, string>();
  const missing: Record<string, string> = {};
  let nextMissing = Math.max(1_000_000_000, ...Object.keys(previousMissing).map(Number).filter(Number.isFinite)) + 1;
  const remap = (id: string): string => {
    if (mapping.has(id)) return mapping.get(id)!;
    const name = sourceNames.get(id) ?? model.columnNames[id] ?? `Column ${id}`;
    const next = nextIds.get(name);
    if (next !== undefined) { mapping.set(id, next); return next; }
    const tombstone = Object.hasOwn(previousMissing, id) ? id : String(nextMissing++);
    mapping.set(id, tombstone); missing[tombstone] = name;
    return tombstone;
  };
  model.fact.measures.forEach((measure) => { measure.columnId = remap(measure.columnId); });
  model.fact.degenerateDimensions.forEach((dimension) => { dimension.columnId = remap(dimension.columnId); });
  model.fact.foreignKeys.forEach((key) => { if (key.sourceColumnId !== null) key.sourceColumnId = remap(key.sourceColumnId); });
  model.dimensions.forEach((dimension) => {
    dimension.columnIds = dimension.columnIds.map(remap);
    dimension.attributes = dimension.attributes.map(remap);
    if (dimension.generated !== "date" && dimension.businessKey) dimension.businessKey = remap(dimension.businessKey);
  });
  model.unassigned = model.unassigned.map(remap);
  model.columnNames = Object.fromEntries(Object.entries(model.columnNames).map(([id, name]) => [remap(id), name]));
  model.reasons = Object.fromEntries(Object.entries(model.reasons).map(([id, reason]) => [remap(id), reason]));
  const assigned = new Set([
    ...model.fact.measures.map((measure) => measure.columnId), ...model.fact.degenerateDimensions.map((dimension) => dimension.columnId),
    ...model.dimensions.flatMap((dimension) => dimension.columnIds), ...model.unassigned,
  ]);
  for (const column of nextColumns) {
    const id = String(column.ordinal);
    model.columnNames[id] ??= column.name.slice(0, 128);
    model.reasons[id] ??= "Added by the preparation pipeline. Assign this column to the model.";
    if (!assigned.has(id)) model.unassigned.push(id);
  }
  return { model, missing };
}

/** Explicit user repair: drop missing assignments without regenerating compatible edits. */
export function removeMissingPreparedAssignments(input: Model, currentColumnIds: readonly string[]): Model {
  const model = structuredClone(input), current = new Set(currentColumnIds);
  model.fact.measures = model.fact.measures.filter((measure) => current.has(measure.columnId));
  model.fact.degenerateDimensions = model.fact.degenerateDimensions.filter((column) => current.has(column.columnId));
  model.dimensions = model.dimensions.map((dimension) => ({
    ...dimension,
    columnIds: dimension.columnIds.filter((id) => current.has(id)),
    attributes: dimension.attributes.filter((id) => current.has(id)),
    businessKey: dimension.generated === "date" || current.has(dimension.businessKey) ? dimension.businessKey : "",
  })).filter((dimension) => dimension.columnIds.length > 0);
  const dimensions = new Set(model.dimensions.map((dimension) => dimension.id));
  model.fact.foreignKeys = model.fact.foreignKeys.filter((key) => dimensions.has(key.dimensionId) && (key.sourceColumnId === null || current.has(key.sourceColumnId)));
  model.unassigned = model.unassigned.filter((id) => current.has(id));
  model.columnNames = Object.fromEntries(Object.entries(model.columnNames).filter(([id]) => current.has(id)));
  model.reasons = Object.fromEntries(Object.entries(model.reasons).filter(([id]) => current.has(id)));
  return model;
}
