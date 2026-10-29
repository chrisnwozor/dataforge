import { stepSchema, type PipelineDefinition, type PrepareStep } from "@/lib/prepare/schema";

export function movePipelineStep(definition: PipelineDefinition, id: string, offset: number): PipelineDefinition {
  const index = definition.steps.findIndex((step) => step.id === id);
  if (index < 0) return definition;
  const target = Math.max(0, Math.min(definition.steps.length - 1, index + offset));
  if (target === index) return definition;
  const steps = [...definition.steps], [step] = steps.splice(index, 1); steps.splice(target, 0, step);
  return { ...definition, steps };
}
export const STEP_GROUPS = [
  { name: "Columns", types: ["select", "drop", "changeType", "derive", "split", "merge", "unpivot"] },
  { name: "Clean & shape", types: ["cleanText", "replace", "fill", "filter", "dedupe", "sort", "conditionalSplit"] },
  { name: "Combine & validate", types: ["join", "union", "quality"] },
] as const;
export const STEP_LABELS: Record<PrepareStep["type"], string> = { select: "Select / Rename / Reorder", drop: "Drop columns", changeType: "Change type", cleanText: "Clean text", replace: "Replace values", fill: "Fill / Default", filter: "Filter rows", derive: "Derive column", split: "Split column", merge: "Merge columns", dedupe: "Deduplicate", join: "Lookup / Join", union: "Union / Append", unpivot: "Unpivot", sort: "Sort", conditionalSplit: "Conditional split", quality: "Quality check" };
export function makePrepareStep(type: PrepareStep["type"], id: string, columns: string[], lookup?: { id: string; columns: string[] }): PrepareStep {
  const column = columns[0] ?? "Column", base = { id, name: STEP_LABELS[type], enabled: true, type };
  const condition = { kind: "condition", column, operator: "empty" };
  const config: Record<PrepareStep["type"], object> = {
    select: { columns: columns.length ? columns.map((name) => ({ name })) : [{ name: column }] }, drop: { columns: [column] }, changeType: { columns: [{ column, type: "text" }], onError: "reject" },
    cleanText: { columns: [column], operations: ["trim"] }, replace: { column, find: "", replacement: "", regex: false }, fill: { columns: [column], mode: "constant", value: "" }, filter: { condition, mode: "drop" },
    derive: { column: columns.includes("Derived") ? "Derived value" : "Derived", expression: `[${column.replaceAll("]", "]]")}]`, onError: "reject" },
    split: { column, mode: "delimiter", delimiter: ",", outputColumns: ["Part 1", "Part 2"], dropOriginal: false }, merge: { columns: columns.slice(0, 2).length ? columns.slice(0, 2) : [column], column: "Merged", separator: " ", dropOriginal: false },
    dedupe: { columns: [column], keep: "first" }, join: { sourceId: lookup?.id ?? "choose-source", keys: [{ left: column, right: lookup?.columns[0] ?? column }], kind: "left", columns: [], multiple: "first" },
    union: { sourceId: lookup?.id ?? "choose-source" }, unpivot: { columns: [column], nameColumn: "Attribute", valueColumn: "Value" }, sort: { columns: [{ column, dir: "asc" }] }, conditionalSplit: { condition, bucket: "Rejected rows" },
    quality: { rules: [{ id: `${id}-rule`, name: `${column} is required`, column, kind: "notNull", severity: "reject", thresholdPct: 0 }] },
  };
  return stepSchema.parse({ ...base, ...config[type] });
}
