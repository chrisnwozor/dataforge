import { z } from "zod";

const id = z.string().min(1).max(128).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "Choose a non-reserved ID.");
export const columnNameSchema = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Column names cannot contain control characters.");
export const cellSchema = z.union([z.string().max(10_000_000), z.number().finite(), z.boolean(), z.null()]);
export type Cell = z.infer<typeof cellSchema>;
export type PrepareRow = Record<string, Cell>;
export const prepareTypeSchema = z.enum(["text", "integer", "decimal", "date", "boolean"]);
export type PrepareType = z.infer<typeof prepareTypeSchema>;
export interface ConditionGroup { kind: "group"; operator: "and" | "or"; conditions: PrepareCondition[] }
export interface ConditionLeaf { kind: "condition"; column: string; operator: "eq" | "ne" | "contains" | "starts" | "ends" | "in" | "gt" | "lt" | "between" | "empty" | "regex"; value?: Cell; values?: Cell[]; upper?: Cell; pattern?: string }
export type PrepareCondition = ConditionGroup | ConditionLeaf;
export const conditionSchema: z.ZodType<PrepareCondition> = z.preprocess((input, context) => {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value: input, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (stack.length) {
    const { value, depth, exit } = stack.pop()!;
    if (exit) { if (value && typeof value === "object") visited.delete(value); continue; }
    if (++nodes > 2_048 || depth > 12 || value && typeof value === "object" && visited.has(value)) { context.addIssue({ code: "custom", message: "Conditions support at most twelve nested groups and 2,048 nodes, without cycles." }); return z.NEVER; }
    if (value && typeof value === "object") {
      visited.add(value); stack.push({ value, depth, exit: true });
      const children = (value as { conditions?: unknown }).conditions;
      if (Array.isArray(children)) for (const child of children) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return input;
}, z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), operator: z.enum(["and", "or"]), conditions: z.array(conditionSchema).min(1).max(32) }).strict(),
  z.object({ kind: z.literal("condition"), column: columnNameSchema, operator: z.enum(["eq", "ne", "contains", "starts", "ends", "in", "gt", "lt", "between", "empty", "regex"]), value: cellSchema.optional(), values: z.array(cellSchema).max(1_000).optional(), upper: cellSchema.optional(), pattern: z.string().max(256).optional() }).strict().superRefine((condition, context) => {
    if (condition.operator === "in" && condition.values === undefined) context.addIssue({ code: "custom", path: ["values"], message: "Provide an in-list values array." });
    if (condition.operator === "regex" && !condition.pattern && typeof condition.value !== "string") context.addIssue({ code: "custom", path: ["pattern"], message: "Provide a regex pattern." });
    if (!["empty", "in", "regex"].includes(condition.operator) && condition.value === undefined) context.addIssue({ code: "custom", path: ["value"], message: "Provide a condition value." });
    if (condition.operator === "between" && condition.upper === undefined) context.addIssue({ code: "custom", path: ["upper"], message: "Provide the upper boundary." });
  }),
])));
export const qualityRuleSchema = z.object({
  id, name: z.string().trim().min(1).max(200), column: columnNameSchema,
  kind: z.enum(["notNull", "unique", "type", "range", "length", "regex", "allowed", "compare"]),
  severity: z.enum(["reject", "warn", "fail"]), thresholdPct: z.number().min(0).max(100).default(0),
  valueType: prepareTypeSchema.optional(), pattern: z.string().max(256).optional(), min: cellSchema.optional(), max: cellSchema.optional(),
  minLength: z.number().int().min(0).max(10_000_000).optional(), maxLength: z.number().int().min(0).max(10_000_000).optional(),
  values: z.array(cellSchema).max(1_000).optional(), otherColumn: columnNameSchema.optional(), comparison: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]).optional(),
}).strict().superRefine((rule, context) => {
  if (rule.kind === "type" && !rule.valueType) context.addIssue({ code: "custom", path: ["valueType"], message: "Choose the required type." });
  if (rule.kind === "range" && (rule.min === undefined || rule.min === null) && (rule.max === undefined || rule.max === null)) context.addIssue({ code: "custom", message: "Provide a minimum or maximum range boundary." });
  if (rule.kind === "length" && rule.minLength === undefined && rule.maxLength === undefined) context.addIssue({ code: "custom", message: "Provide a minimum or maximum length." });
  if (rule.kind === "length" && rule.minLength !== undefined && rule.maxLength !== undefined && rule.minLength > rule.maxLength) context.addIssue({ code: "custom", message: "Minimum length must not exceed maximum length." });
  if (rule.kind === "regex" && !rule.pattern) context.addIssue({ code: "custom", path: ["pattern"], message: "Provide a regex pattern." });
  if (rule.kind === "allowed" && rule.values === undefined) context.addIssue({ code: "custom", path: ["values"], message: "Provide an allowed-values list." });
  if (rule.kind === "compare" && (!rule.otherColumn || !rule.comparison)) context.addIssue({ code: "custom", message: "Choose a comparison column and operator." });
});
export type QualityRule = z.infer<typeof qualityRuleSchema>;
const common = z.object({ id, name: z.string().max(200).default(""), enabled: z.boolean().default(true) }).strict();
const names = z.array(columnNameSchema).min(1).max(10_000);
export const stepSchema = z.discriminatedUnion("type", [
  common.extend({ type: z.literal("select"), columns: z.array(z.object({ name: columnNameSchema, rename: columnNameSchema.optional() }).strict()).min(1).max(10_000) }),
  common.extend({ type: z.literal("drop"), columns: names }),
  common.extend({ type: z.literal("changeType"), columns: z.array(z.object({ column: columnNameSchema, type: prepareTypeSchema, pattern: z.string().max(100).optional() }).strict()).min(1).max(10_000), onError: z.enum(["reject", "null", "keep"]).default("reject") }),
  common.extend({ type: z.literal("cleanText"), columns: names, operations: z.array(z.enum(["trim", "collapse", "upper", "lower", "title", "nonPrinting", "accents"])).min(1).max(7) }),
  common.extend({ type: z.literal("replace"), column: columnNameSchema, map: z.array(z.object({ from: cellSchema, to: cellSchema }).strict()).max(1_000).optional(), find: z.string().max(256).optional(), replacement: z.string().max(10_000).default(""), regex: z.boolean().default(false), flags: z.string().max(8).default("") }),
  common.extend({ type: z.literal("fill"), columns: names, mode: z.enum(["constant", "previous", "mean", "median"]), value: cellSchema.optional() }),
  common.extend({ type: z.literal("filter"), condition: conditionSchema, mode: z.enum(["keep", "drop"]).default("keep") }),
  common.extend({ type: z.literal("derive"), column: columnNameSchema, expression: z.string().min(1).max(8_192), onError: z.enum(["reject", "null", "keep"]).default("reject") }),
  common.extend({ type: z.literal("split"), column: columnNameSchema, mode: z.enum(["delimiter", "width"]), delimiter: z.string().min(1).max(100).optional(), widths: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(100).optional(), outputColumns: z.array(columnNameSchema).min(1).max(100), dropOriginal: z.boolean().default(false) }),
  common.extend({ type: z.literal("merge"), columns: names, column: columnNameSchema, separator: z.string().max(100).default(" "), dropOriginal: z.boolean().default(false) }),
  common.extend({ type: z.literal("dedupe"), columns: names, keep: z.enum(["first", "last", "max", "min"]).default("first"), valueColumn: columnNameSchema.optional() }),
  common.extend({ type: z.literal("join"), sourceId: id, keys: z.array(z.object({ left: columnNameSchema, right: columnNameSchema }).strict()).min(1).max(32), kind: z.enum(["left", "inner"]).default("left"), columns: z.array(z.object({ source: columnNameSchema, target: columnNameSchema }).strict()).max(10_000), multiple: z.enum(["first", "error", "reject"]).default("first") }),
  common.extend({ type: z.literal("union"), sourceId: id, mappings: z.array(z.object({ source: columnNameSchema, target: columnNameSchema }).strict()).max(10_000).optional() }),
  common.extend({ type: z.literal("unpivot"), columns: names, nameColumn: columnNameSchema, valueColumn: columnNameSchema }),
  common.extend({ type: z.literal("sort"), columns: z.array(z.object({ column: columnNameSchema, dir: z.enum(["asc", "desc"]) }).strict()).min(1).max(32) }),
  common.extend({ type: z.literal("conditionalSplit"), condition: conditionSchema, bucket: z.string().trim().min(1).max(120) }),
  common.extend({ type: z.literal("quality"), rules: z.array(qualityRuleSchema).min(1).max(100) }),
]);
export type PrepareStep = z.infer<typeof stepSchema>;
export const pipelineDefinitionSchema = z.object({
  version: z.literal(1), mainSourceId: id, steps: z.array(stepSchema).max(100),
  options: z.object({ memoryMb: z.number().min(0.000001).max(2048).default(150), maxMaterializedRows: z.number().int().min(1).max(5_000_000).default(500_000) }).strict().default({ memoryMb: 150, maxMaterializedRows: 500_000 }),
}).strict().superRefine((definition, context) => {
  const ids = new Set<string>();
  definition.steps.forEach((step, index) => {
    if (ids.has(step.id)) context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "Each pipeline step needs a unique ID." });
    ids.add(step.id);
    if (step.type === "dedupe" && ["max", "min"].includes(step.keep) && !step.valueColumn) context.addIssue({ code: "custom", path: ["steps", index], message: "Choose a comparison column for min/max deduplication." });
    if (step.type === "split" && (step.mode === "delimiter" ? !step.delimiter : !step.widths?.length)) context.addIssue({ code: "custom", path: ["steps", index], message: "Choose a split delimiter or fixed widths." });
    if (step.type === "select" && new Set(step.columns.map((column) => column.rename ?? column.name)).size !== step.columns.length) context.addIssue({ code: "custom", path: ["steps", index], message: "Selected output columns need distinct names." });
    if (step.type === "unpivot" && step.nameColumn === step.valueColumn) context.addIssue({ code: "custom", path: ["steps", index], message: "Unpivot name and value columns must differ." });
    if (step.type === "quality" && new Set(step.rules.map((rule) => rule.id)).size !== step.rules.length) context.addIssue({ code: "custom", path: ["steps", index], message: "Quality rule IDs must be unique within a step." });
    const scan = (condition: PrepareCondition, depth: number): void => {
      if (depth > 12) { context.addIssue({ code: "custom", path: ["steps", index], message: "Conditions support at most twelve nested groups." }); return; }
      if (condition.kind === "group") condition.conditions.forEach((child) => scan(child, depth + 1));
    };
    if (step.type === "filter" || step.type === "conditionalSplit") scan(step.condition, 0);
  });
});
export type PipelineDefinition = z.infer<typeof pipelineDefinitionSchema>;
export function defaultPipeline(mainSourceId: string): PipelineDefinition { return pipelineDefinitionSchema.parse({ version: 1, mainSourceId, steps: [] }); }
