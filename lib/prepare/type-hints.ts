import type { PipelineDefinition, PrepareType } from "./schema";

/** CSV has no type metadata; retain explicit conversions until a later value-changing step. */
export function preparedTypeHints(definition: PipelineDefinition): Map<string, PrepareType> {
  let hints = new Map<string, PrepareType>();
  for (const step of definition.steps) {
    if (!step.enabled) continue;
    switch (step.type) {
      case "changeType":
        for (const column of step.columns) {
          if (step.onError !== "keep" || column.type === "text") hints.set(column.column, column.type);
          else hints.delete(column.column);
        }
        break;
      case "select": {
        const selected = new Map<string, PrepareType>();
        for (const column of step.columns) { const type = hints.get(column.name); if (type) selected.set(column.rename ?? column.name, type); }
        hints = selected; break;
      }
      case "drop": case "cleanText": case "fill":
        step.columns.forEach((column) => hints.delete(column)); break;
      case "replace": case "derive": hints.delete(step.column); break;
      case "split":
        if (step.dropOriginal) hints.delete(step.column);
        step.outputColumns.forEach((column) => hints.delete(column)); break;
      case "merge":
        if (step.dropOriginal) step.columns.forEach((column) => hints.delete(column));
        hints.delete(step.column); break;
      case "join": step.columns.forEach((column) => hints.delete(column.target)); break;
      case "union":
        if (step.mappings) step.mappings.forEach((column) => hints.delete(column.target));
        else hints.clear();
        break;
      case "unpivot": step.columns.forEach((column) => hints.delete(column)); hints.delete(step.nameColumn); hints.delete(step.valueColumn); break;
      default: break;
    }
  }
  return hints;
}
