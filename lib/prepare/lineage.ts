import { pipelineDefinitionSchema, type PipelineDefinition, type PrepareCondition, type PrepareStep } from "./schema";
import type { ColumnLineage, EngineSource, PipelineValidation } from "./types";

/** Extract bracket references while excluding quoted string literals. */
export function expressionColumnReferences(expression: string): string[] {
  const refs = new Set<string>();
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "'" || char === '"') {
      for (index++; index < expression.length; index++) if (expression[index] === char) { if (expression[index + 1] === char) index++; else break; }
    } else if (char === "[") {
      let name = "";
      for (index++; index < expression.length; index++) {
        if (expression[index] === "]") { if (expression[index + 1] === "]") { name += "]"; index++; } else break; }
        else name += expression[index];
      }
      if (name) refs.add(name);
    }
  }
  return [...refs];
}
export function conditionColumns(condition: PrepareCondition): string[] { return condition.kind === "group" ? [...new Set(condition.conditions.flatMap(conditionColumns))] : [condition.column]; }
export function stepInputColumns(step: PrepareStep): string[] {
  switch (step.type) {
    case "select": return step.columns.map((column) => column.name);
    case "drop": case "cleanText": case "fill": case "merge": case "unpivot": return step.columns;
    case "changeType": case "sort": return step.columns.map((column) => column.column);
    case "replace": case "split": return [step.column];
    case "filter": case "conditionalSplit": return conditionColumns(step.condition);
    case "derive": return expressionColumnReferences(step.expression);
    case "dedupe": return [...step.columns, ...(step.valueColumn ? [step.valueColumn] : [])];
    case "join": return step.keys.map((key) => key.left);
    case "quality": return [...new Set(step.rules.flatMap((rule) => [rule.column, ...(rule.otherColumn ? [rule.otherColumn] : [])]))];
    case "union": return [];
  }
}
function distinct(values: string[]): string[] { return [...new Set(values)]; }
function copy(line: ColumnLineage): ColumnLineage { return { column: line.column, sources: [...line.sources], steps: [...line.steps] }; }

/** Pure, browser-safe column validation and lineage; no source files are opened. */
export function analyzePipeline(input: PipelineDefinition, sources: readonly Pick<EngineSource, "id" | "columns">[], stopAfterStep?: number): PipelineValidation {
  const parsed = pipelineDefinitionSchema.safeParse(input);
  if (!parsed.success) return { valid: false, errors: parsed.error.issues.map((issue) => ({ message: issue.message })), columns: [], lineage: [] };
  const definition = parsed.data;
  const main = sources.find((source) => source.id === definition.mainSourceId);
  if (!main) return { valid: false, errors: [{ message: "Choose an available main source." }], columns: [], lineage: [] };
  let columns = [...main.columns];
  let lineage = new Map(columns.map((column) => [column, { column, sources: [{ sourceId: main.id, column }], steps: [] } as ColumnLineage]));
  const errors: PipelineValidation["errors"] = [];
  const error = (stepId: string, message: string) => errors.push({ stepId, message });
  for (const [index, step] of definition.steps.entries()) {
    if (stopAfterStep !== undefined && index > stopAfterStep) break;
    if (!step.enabled) continue;
    for (const column of stepInputColumns(step)) if (!columns.includes(column)) error(step.id, `Column “${column}” is unavailable at this step.`);
    const prior = lineage;
    const touch = { id: step.id, name: step.name || step.type, type: step.type };
    const combine = (output: string, inputs: string[], external: ColumnLineage["sources"] = []): ColumnLineage => {
      const inputLines = inputs.map((column) => prior.get(column)).filter((value): value is ColumnLineage => !!value);
      const allSources = [...inputLines.flatMap((line) => line.sources), ...external];
      const allSteps = [...inputLines.flatMap((line) => line.steps), touch];
      return { column: output, sources: [...new Map(allSources.map((source) => [JSON.stringify(source), source])).values()], steps: [...new Map(allSteps.map((entry) => [entry.id, entry])).values()] };
    };
    lineage = new Map([...prior].map(([name, line]) => [name, copy(line)]));
    switch (step.type) {
      case "select": columns = step.columns.map((column) => column.rename ?? column.name); lineage = new Map(step.columns.map((column) => [column.rename ?? column.name, combine(column.rename ?? column.name, [column.name])])); break;
      case "drop": columns = columns.filter((column) => !step.columns.includes(column)); step.columns.forEach((column) => lineage.delete(column)); break;
      case "derive": columns = distinct([...columns, step.column]); lineage.set(step.column, combine(step.column, expressionColumnReferences(step.expression))); break;
      case "split": {
        const retained = step.dropOriginal ? columns.filter((column) => column !== step.column) : columns;
        for (const column of step.outputColumns) if (retained.includes(column)) error(step.id, `Output column “${column}” already exists; choose a different name.`);
        columns = distinct([...retained, ...step.outputColumns]); if (step.dropOriginal) lineage.delete(step.column);
        step.outputColumns.forEach((column) => lineage.set(column, combine(column, [step.column]))); break;
      }
      case "merge": {
        columns = distinct([...(step.dropOriginal ? columns.filter((column) => !step.columns.includes(column)) : columns), step.column]);
        if (step.dropOriginal) step.columns.forEach((column) => lineage.delete(column));
        lineage.set(step.column, combine(step.column, step.columns)); break;
      }
      case "join": {
        const source = sources.find((entry) => entry.id === step.sourceId);
        if (!source) error(step.id, "Choose an available lookup source.");
        for (const ref of [...step.keys.map((key) => key.right), ...step.columns.map((column) => column.source)]) if (source && !source.columns.includes(ref)) error(step.id, `Lookup column “${ref}” is unavailable.`);
        for (const column of step.columns) {
          if (columns.includes(column.target)) error(step.id, `Join output “${column.target}” already exists; rename it.`);
          columns.push(column.target); lineage.set(column.target, combine(column.target, step.keys.map((key) => key.left), [{ sourceId: step.sourceId, column: column.source }]));
        }
        break;
      }
      case "union": {
        const source = sources.find((entry) => entry.id === step.sourceId);
        if (!source) error(step.id, "Choose an available append source.");
        const mapping = step.mappings ?? columns.map((column) => ({ source: column, target: column }));
        if (source) for (const column of mapping) {
          if (!source.columns.includes(column.source)) error(step.id, `Append column “${column.source}” is unavailable; provide an explicit mapping.`);
          if (!columns.includes(column.target)) error(step.id, `Append target “${column.target}” is unavailable.`);
          lineage.set(column.target, combine(column.target, [column.target], [{ sourceId: step.sourceId, column: column.source }]));
        }
        break;
      }
      case "unpivot": {
        const retained = columns.filter((column) => !step.columns.includes(column));
        for (const column of [step.nameColumn, step.valueColumn]) if (retained.includes(column)) error(step.id, `Unpivot output “${column}” already exists.`);
        columns = [...retained, step.nameColumn, step.valueColumn]; step.columns.forEach((column) => lineage.delete(column));
        lineage.set(step.nameColumn, combine(step.nameColumn, step.columns)); lineage.set(step.valueColumn, combine(step.valueColumn, step.columns)); break;
      }
      default: stepInputColumns(step).forEach((column) => { if (lineage.has(column)) lineage.set(column, combine(column, [column])); });
    }
    if (!columns.length) error(step.id, "Keep at least one output column.");
    if (new Set(columns).size !== columns.length) error(step.id, "Output columns must have unique names.");
    if (columns.length > 10_000) error(step.id, "The prepared output exceeds 10,000 columns.");
  }
  return { valid: errors.length === 0, errors, columns, lineage: columns.map((column) => lineage.get(column)!) };
}
export const pipelineLineage = analyzePipeline;
