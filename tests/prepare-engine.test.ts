import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { executePipeline, MemoryBudgetError, QualityThresholdError } from "@/lib/prepare/engine";
import { analyzePipeline } from "@/lib/prepare/lineage";
import { createPipelineHistory, pipelineHistoryReducer } from "@/lib/prepare/history";
import { encodeCsvRow, rowsToCsv } from "@/lib/prepare/csv";
import { defaultPipeline, pipelineDefinitionSchema, type PipelineDefinition, type PrepareRow } from "@/lib/prepare/schema";
import type { EngineOptions, EngineSource, PrepareReject } from "@/lib/prepare/types";

function source(id: string, rows: PrepareRow[], columns = Object.keys(rows[0] ?? {})): EngineSource {
  return { id, columns, async *open({ limit, signal } = {}) { let count = 0; for (const row of rows) { signal?.throwIfAborted(); if (count++ >= (limit ?? Infinity)) break; yield row; } } };
}
function definition(steps: unknown[] = [], options?: { memoryMb?: number; maxMaterializedRows?: number }): PipelineDefinition {
  return pipelineDefinitionSchema.parse({ version: 1, mainSourceId: "main", steps: steps.map((step, index) => ({ id: `step-${index}`, ...(step as object) })), ...(options ? { options } : {}) });
}
async function run(rows: PrepareRow[], steps: unknown[] = [], extras: EngineSource[] = [], options: EngineOptions = {}, limits?: Parameters<typeof definition>[1]) {
  const rejects: PrepareReject[] = [];
  const execution = await executePipeline(definition(steps, limits), [source("main", rows), ...extras], { ...options, onReject: async (reject) => { rejects.push(reject); await options.onReject?.(reject); } });
  const output: PrepareRow[] = [];
  for await (const row of execution.rows) output.push(row);
  return { output, summary: execution.summary, columns: execution.columns, rejects };
}
const condition = (column: string, operator: string, value?: unknown) => ({ kind: "condition", column, operator, ...(value === undefined ? {} : { value }) });

describe("streaming preparation steps", () => {
  it("passes legacy sources through without opening ahead, mutating rows or unsafe prototype writes", async () => {
    let reads = 0, closed = false;
    const row = JSON.parse('{"__proto__":"safe","constructor":"literal","Name":" A "}') as PrepareRow;
    const input: EngineSource = { id: "main", columns: Object.keys(row), async *open() { try { for (let index = 0; index < 10; index++) { reads++; yield row; } } finally { closed = true; } } };
    const execution = await executePipeline(defaultPipeline("main"), [input]);
    expect(reads).toBe(0);
    const iterator = execution.rows[Symbol.asyncIterator]();
    const first = await iterator.next(); expect(reads).toBe(1);
    expect(first.value?.["__proto__"]).toBe("safe"); expect(first.value?.constructor).toBe("literal");
    await execution.close(); expect(closed).toBe(true); expect(reads).toBe(1);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });
  it("selects, renames, reorders and drops columns while preserving lineage", async () => {
    const steps = [{ type: "select", columns: [{ name: "B", rename: "Beta" }, { name: "A" }, { name: "C" }] }, { type: "drop", columns: ["C"] }];
    const result = await run([{ A: 1, B: 2, C: 3 }], steps);
    expect(result.columns).toEqual(["Beta", "A"]); expect(result.output).toEqual([{ Beta: 2, A: 1 }]);
    const lineage = analyzePipeline(definition(steps), [source("main", [{ A: 1, B: 2, C: 3 }])]);
    expect(lineage.lineage[0]).toMatchObject({ column: "Beta", sources: [{ sourceId: "main", column: "B" }], steps: [{ id: "step-0" }] });
  });
  it("rejects invalid types with original values and row numbers, or sets null/keeps text", async () => {
    const rows = [{ Age: "12" }, { Age: "bad" }];
    const step = { type: "changeType", columns: [{ column: "Age", type: "integer" }] };
    const rejected = await run(rows, [step]); expect(rejected.output).toEqual([{ Age: 12 }]);
    expect(rejected.rejects[0]).toMatchObject({ rowNumber: 2, values: { Age: "bad" } }); expect(rejected.summary.rowsRejected).toBe(1);
    expect((await run(rows, [{ ...step, onError: "null" }])).output).toEqual([{ Age: 12 }, { Age: null }]);
    expect((await run(rows, [{ ...step, onError: "keep" }])).output).toEqual([{ Age: 12 }, { Age: "bad" }]);
    expect((await run([{ Date: "31/12/2024" }], [{ type: "changeType", columns: [{ column: "Date", type: "date", pattern: "dd/MM/yyyy" }] }])).output[0].Date).toBe("2024-12-31");
    expect(rows[0].Age).toBe("12");
  });
  it("applies text cleaning operations in the chosen order", async () => {
    const result = await run([{ Name: "  jOSÉ\u0000   duPONT  ", Blank: null }], [{ type: "cleanText", columns: ["Name", "Blank"], operations: ["nonPrinting", "accents", "trim", "collapse", "title"] }]);
    expect(result.output).toEqual([{ Name: "Jose Dupont", Blank: null }]);
    expect((await run([{ Name: "MiXeD" }], [{ type: "cleanText", columns: ["Name"], operations: ["upper", "lower"] }])).output[0].Name).toBe("mixed");
  });
  it("replaces exact values, literal occurrences and guarded regex matches", async () => {
    expect((await run([{ A: "old" }, { A: null }], [{ type: "replace", column: "A", map: [{ from: "old", to: "new" }, { from: null, to: "missing" }] }])).output).toEqual([{ A: "new" }, { A: "missing" }]);
    expect((await run([{ A: "a.a.a" }], [{ type: "replace", column: "A", find: ".", replacement: "-" }])).output[0].A).toBe("a-a-a");
    expect((await run([{ A: "Order 123" }], [{ type: "replace", column: "A", find: "[0-9]+", replacement: "ID", regex: true }])).output[0].A).toBe("Order ID");
  });
  it("fills constants/previous values and bounded mean/median from the same step input", async () => {
    const rows = [{ A: null }, { A: 1 }, { A: "" }, { A: 9 }, { A: 4 }];
    expect((await run(rows, [{ type: "fill", columns: ["A"], mode: "constant", value: 0 }])).output.map((row) => row.A)).toEqual([0, 1, 0, 9, 4]);
    expect((await run(rows, [{ type: "fill", columns: ["A"], mode: "previous" }])).output.map((row) => row.A)).toEqual([null, 1, 1, 9, 4]);
    expect((await run(rows, [{ type: "fill", columns: ["A"], mode: "mean" }])).output[0].A).toBeCloseTo(14 / 3);
    expect((await run(rows, [{ type: "fill", columns: ["A"], mode: "median" }])).output[0].A).toBe(4);
    expect((await run([{ A: 1 }, { A: 9 }, { A: null }], [{ type: "fill", columns: ["A"], mode: "median" }])).output.at(-1)?.A).toBe(5);
    await expect(run(rows, [{ type: "fill", columns: ["A"], mode: "mean" }], [], {}, { maxMaterializedRows: 2 })).rejects.toBeInstanceOf(MemoryBudgetError);
  });
  it("combines conditions, supports drop mode, and keeps filtering separate from quality rejects", async () => {
    const rows = [{ Name: "Alice", N: 2 }, { Name: "Bob", N: 9 }, { Name: "Al", N: null }];
    const group = { kind: "group", operator: "and", conditions: [condition("Name", "starts", "Al"), { ...condition("N", "between", 1), upper: 3 }] };
    const result = await run(rows, [{ type: "filter", condition: group }]); expect(result.output).toEqual([rows[0]]); expect(result.summary.steps[0].removed).toBe(2); expect(result.summary.rowsRejected).toBe(0);
    expect((await run(rows, [{ type: "filter", condition: condition("N", "empty"), mode: "drop" }])).output).toHaveLength(2);
    expect((await run(rows, [{ type: "filter", condition: { kind: "group", operator: "or", conditions: [condition("Name", "eq", "Bob"), condition("Name", "ends", "ce")] } }])).output).toHaveLength(2);
    expect((await run(rows, [{ type: "filter", condition: { ...condition("Name", "in"), values: ["Bob"] } }])).output).toEqual([rows[1]]);
    expect((await run(rows, [{ type: "filter", condition: { ...condition("Name", "regex"), pattern: "^Al" } }])).output).toHaveLength(2);
  });
  it("derives columns once-compiled, propagates nulls and reports row expression errors", async () => {
    const result = await run([{ Sales: "100", Profit: "20" }, { Sales: "0", Profit: "4" }], [{ type: "derive", column: "Margin", expression: "IF(TONUMBER([Sales]) = 0, NULL, ROUND(TONUMBER([Profit]) / TONUMBER([Sales]), 2))" }]);
    expect(result.output.map((row) => row.Margin)).toEqual([0.2, null]);
    expect((await run([{ N: "bad" }], [{ type: "derive", column: "N2", expression: "TONUMBER([N])", onError: "null" }])).output[0].N2).toBeNull();
    const rejected = await run([{ N: "bad" }], [{ type: "derive", column: "N2", expression: "TONUMBER([N])" }]); expect(rejected.rejects).toHaveLength(1);
    await expect(run([{ N: 1 }], [{ type: "derive", column: "N2", expression: "process.exit()" }])).rejects.toThrow();
  });
  it("splits by delimiter/fixed widths and merges without losing overflow or null positions", async () => {
    const split = await run([{ Name: "A,B,C" }], [{ type: "split", column: "Name", mode: "delimiter", delimiter: ",", outputColumns: ["First", "Rest"], dropOriginal: true }]);
    expect(split.output).toEqual([{ First: "A", Rest: "B,C" }]);
    expect((await run([{ Code: "AB123rest" }], [{ type: "split", column: "Code", mode: "width", widths: [2, 3], outputColumns: ["Prefix", "Digits", "Rest"] }])).output[0]).toMatchObject({ Prefix: "AB", Digits: "123", Rest: "rest" });
    expect((await run([{ A: "One", B: null }], [{ type: "merge", columns: ["A", "B"], column: "Both", separator: "|", dropOriginal: true }])).output).toEqual([{ Both: "One|" }]);
  });
  it.each(["first", "last", "max", "min"])("deduplicates with %s and counts removed rows", async (keep) => {
    const result = await run([{ ID: "A", N: 3 }, { ID: "B", N: 2 }, { ID: "A", N: 1 }, { ID: "A", N: 5 }], [{ type: "dedupe", columns: ["ID"], keep, valueColumn: "N" }]);
    expect(result.output.find((row) => row.ID === "A")?.N).toBe(keep === "first" ? 3 : keep === "min" ? 1 : 5);
    expect(result.summary.steps[0].removed).toBe(2); expect(result.summary.rowsRejected).toBe(0);
    if (keep === "last" || keep === "max") expect(result.output.map((row) => row.ID)).toEqual(["B", "A"]);
  });
  it("compares raw numeric CSV strings for min/max dedupe and avoids fill-statistic overflow", async () => {
    const rows = [{ ID: "A", N: "9" }, { ID: "A", N: "10" }];
    expect((await run(rows, [{ type: "dedupe", columns: ["ID"], keep: "max", valueColumn: "N" }])).output[0].N).toBe("10");
    expect((await run(rows, [{ type: "dedupe", columns: ["ID"], keep: "min", valueColumn: "N" }])).output[0].N).toBe("9");
    for (const mode of ["mean", "median"]) expect((await run([{ N: 1e308 }, { N: 1e308 }, { N: null }], [{ type: "fill", columns: ["N"], mode }])).output[2].N).toBe(1e308);
  });
  it("sorts stably with nulls and an explicit materialization budget", async () => {
    const rows = [{ ID: "A", N: 2 }, { ID: "B", N: null }, { ID: "C", N: 2 }, { ID: "D", N: 1 }];
    expect((await run(rows, [{ type: "sort", columns: [{ column: "N", dir: "asc" }] }])).output.map((row) => row.ID)).toEqual(["B", "D", "A", "C"]);
    await expect(run(rows, [{ type: "sort", columns: [{ column: "N", dir: "asc" }] }], [], {}, { memoryMb: 0.00001 })).rejects.toThrow("smaller lookup");
  });
  it("un-pivots selected columns and routes conditional rejects with original values", async () => {
    const rows = [{ ID: "A", Jan: 10, Feb: 20 }];
    const result = await run(rows, [{ type: "unpivot", columns: ["Jan", "Feb"], nameColumn: "Month", valueColumn: "Sales" }, { type: "conditionalSplit", condition: condition("Sales", "gt", 15), bucket: "large-sales" }]);
    expect(result.output).toEqual([{ ID: "A", Month: "Jan", Sales: 10 }]);
    expect(result.rejects[0]).toMatchObject({ bucket: "large-sales", rowNumber: 1, values: rows[0] });
    expect(result.summary.rowsRejected).toBe(1);
  });
});

describe("multiple source joins and appends", () => {
  const join = { type: "join", sourceId: "lookup", keys: [{ left: "ID", right: "Key" }], columns: [{ source: "Name", target: "Customer" }] };
  it("supports composite/normalized keys, left/inner joins and leaves empty keys unmatched", async () => {
    const lookup = source("lookup", [{ Key: 1, Name: "Alice" }, { Key: null, Name: "Unknown" }]);
    const rows = [{ ID: "1" }, { ID: "2" }, { ID: null }];
    expect((await run(rows, [join], [lookup])).output).toEqual([{ ID: "1", Customer: "Alice" }, { ID: "2", Customer: null }, { ID: null, Customer: null }]);
    expect((await run(rows, [{ ...join, kind: "inner" }], [lookup])).output).toEqual([{ ID: "1", Customer: "Alice" }]);
    const composite = { ...join, keys: [{ left: "ID", right: "Key" }, { left: "Region", right: "Region" }] };
    const result = await run([{ ID: 1, Region: "East" }], [composite], [source("lookup", [{ Key: "1", Region: "West", Name: "Other" }, { Key: "1", Region: "East", Name: "Correct" }])]);
    expect(result.output[0].Customer).toBe("Correct");
  });
  it("enforces first/error/reject duplicate lookup policies and lookup memory caps", async () => {
    const lookup = source("lookup", [{ Key: "1", Name: "First" }, { Key: "1", Name: "Second" }]);
    expect((await run([{ ID: "1" }], [join], [lookup])).output[0].Customer).toBe("First");
    await expect(run([{ ID: "1" }], [{ ...join, multiple: "error" }], [lookup])).rejects.toThrow("multiple matches");
    expect((await run([{ ID: "1" }], [{ ...join, multiple: "reject" }], [lookup])).rejects).toHaveLength(1);
    await expect(run([{ ID: "1" }], [join], [lookup], {}, { memoryMb: 0.00001 })).rejects.toBeInstanceOf(MemoryBudgetError);
  });
  it("shares one materialization budget across simultaneous lookup maps and counts key bytes", async () => {
    const lookups = [source("lookup", [{ Key: "1", Name: "A" }]), source("second", [{ Key: "1", Name: "B" }])];
    await expect(run([{ ID: "1" }], [join, { ...join, sourceId: "second", columns: [{ source: "Name", target: "Other" }] }], lookups, {}, { maxMaterializedRows: 1 })).rejects.toBeInstanceOf(MemoryBudgetError);
    await expect(run([{ ID: "x".repeat(1_000) }], [{ type: "dedupe", columns: ["ID"], keep: "first" }], [], {}, { memoryMb: 0.001 })).rejects.toBeInstanceOf(MemoryBudgetError);
    const projected = await run([{ ID: "1" }], [join], [source("lookup", [{ Key: "1", Name: "A", UnusedLargeValue: "x".repeat(10_000) }])], {}, { memoryMb: 0.001 });
    expect(projected.output[0].Customer).toBe("A");
  });
  it("appends matching/mapped columns and retains stream order through keep-last dedupe", async () => {
    const result = await run([{ ID: "A", N: 1 }], [{ type: "union", sourceId: "more", mappings: [{ source: "Code", target: "ID" }, { source: "Value", target: "N" }] }, { type: "dedupe", columns: ["ID"], keep: "last" }], [source("more", [{ Code: "B", Value: 2 }, { Code: "A", Value: 3 }])]);
    expect(result.output).toEqual([{ ID: "B", N: 2 }, { ID: "A", N: 3 }]);
    expect(result.summary.rowsRead).toBe(3); expect(result.summary.steps[0].rowsIn).toBe(3);
    await expect(run([{ ID: "A" }], [{ type: "union", sourceId: "more" }], [source("more", [{ Other: 1 }])])).rejects.toThrow("explicit mapping");
  });
});

describe("quality rules, safety and bounded previews", () => {
  const quality = (rules: unknown[]) => ({ type: "quality", rules: rules.map((rule, index) => ({ id: `rule-${index}`, name: `Rule ${index}`, column: "N", severity: "reject", ...(rule as object) })) });
  it("rejects not-null, unique, type, range, length, regex, allowed and cross-column violations", async () => {
    const cases = [
      [{ kind: "notNull" }, { N: null }], [{ kind: "unique" }, { N: 1 }], [{ kind: "type", valueType: "integer" }, { N: "x" }],
      [{ kind: "range", min: 1, max: 10 }, { N: 12 }], [{ kind: "length", minLength: 2, maxLength: 3 }, { N: "long" }],
      [{ kind: "regex", pattern: "^[0-9]+$" }, { N: "bad" }], [{ kind: "allowed", values: [1, 2] }, { N: 9 }],
      [{ kind: "compare", otherColumn: "Other", comparison: "gte" }, { N: 1, Other: 2 }],
    ] as const;
    for (const [rule, invalid] of cases) { const rows = rule.kind === "unique" ? [{ ...invalid }, { ...invalid }] : [{ ...invalid }]; const result = await run(rows, [quality([rule])]); expect(result.summary.rowsRejected).toBe(1); expect(result.summary.rules[0].failed).toBe(1); }
  });
  it("keeps warning rows, counts each rule, rejects a row once for multiple errors and honors strict fail thresholds", async () => {
    const rows = [{ N: -1 }, { N: 2 }];
    const warning = await run(rows, [quality([{ kind: "range", min: 0, severity: "warn" }])]);
    expect(warning.output).toHaveLength(2); expect(warning.rejects).toHaveLength(0); expect(warning.summary.rules[0].ratePct).toBe(50);
    const rejected = await run(rows, [quality([{ kind: "range", min: 0 }, { kind: "allowed", values: [2] }])]);
    expect(rejected.summary.rowsRejected).toBe(1); expect(rejected.rejects).toHaveLength(2);
    expect((await run(rows, [quality([{ kind: "range", min: 0, severity: "fail", thresholdPct: 50 }])])).output).toHaveLength(2);
    const execution = await executePipeline(definition([quality([{ kind: "range", min: 0, severity: "fail", thresholdPct: 49 }])]), [source("main", rows)]);
    await expect((async () => { for await (const row of execution.rows) void row; })()).rejects.toBeInstanceOf(QualityThresholdError);
    expect(execution.summary.rules[0]).toMatchObject({ failed: 1, checked: 2, ratePct: 50 });
  });
  it("applies the preview cap to every source, closes each source, and uses the same full-run engine", async () => {
    const rows = Array.from({ length: 20 }, (_, N) => ({ N }));
    const steps = [{ type: "cleanText", columns: ["N"], operations: ["trim"] }, { type: "derive", column: "Double", expression: "TONUMBER([N]) * 2" }];
    expect((await run(rows, steps, [], { sourceLimit: 5 })).output).toEqual((await run(rows.slice(0, 5), steps)).output);
    const result = await run(rows, [{ type: "union", sourceId: "more" }], [source("more", rows)], { sourceLimit: 3 });
    expect(result.summary.rowsRead).toBe(6); expect(result.output).toHaveLength(6);
  });
  it("caps expanded output without materializing it and permits an exact-cap result", async () => {
    const steps = [{ type: "unpivot", columns: ["A", "B", "C"], nameColumn: "Name", valueColumn: "Value" }];
    const rows = [{ A: 1, B: 2, C: 3 }];
    await expect(run(rows, steps, [], { maxOutputRows: 2 })).rejects.toThrow("Reduce unpivot/append");
    const discard = { type: "filter", mode: "keep", condition: { kind: "condition", column: "Value", operator: "gt", value: 100 } };
    await expect(run(rows, [...steps, discard], [], { maxOutputRows: 2 })).rejects.toThrow("Reduce unpivot/append");
    expect((await run(rows, steps, [], { maxOutputRows: 3 })).output).toHaveLength(3);
    await expect(run(rows, steps, [], { maxOutputRows: 5_000_001 })).rejects.toThrow("5,000,000");
  });
  it("yields for cancellation during unpivot even when a later filter discards every expanded row", async () => {
    const row = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`C${index}`, 1]));
    const abort = new AbortController();
    setImmediate(() => abort.abort());
    await expect(run([row], [
      { type: "unpivot", columns: Object.keys(row), nameColumn: "Name", valueColumn: "Value" },
      { type: "filter", mode: "keep", condition: { kind: "condition", column: "Value", operator: "gt", value: 100 } },
    ], [], { signal: abort.signal })).rejects.toThrow(/abort/i);
  });
  it("cancels in-flight streaming work and never consumes additional rows after cancellation", async () => {
    const abort = new AbortController(); let reads = 0;
    const input: EngineSource = { id: "main", columns: ["N"], async *open() { for (let N = 0; N < 10; N++) { reads++; yield { N }; } } };
    const execution = await executePipeline(defaultPipeline("main"), [input], { signal: abort.signal });
    const iterator = execution.rows[Symbol.asyncIterator](); await iterator.next(); abort.abort(); await expect(iterator.next()).rejects.toThrow(); expect(reads).toBe(1);
  });
  it("rejects bad versions, duplicate IDs, unavailable columns and deeply nested condition inputs safely", () => {
    expect(pipelineDefinitionSchema.safeParse({ version: 2, mainSourceId: "main", steps: [] }).success).toBe(false);
    expect(() => definition([{ id: "same", type: "drop", columns: ["A"] }, { id: "same", type: "drop", columns: ["B"] }])).toThrow();
    expect(analyzePipeline(definition([{ type: "derive", column: "New", expression: "[Missing] + 1" }]), [source("main", [{ A: 1 }])]).valid).toBe(false);
    let nested: unknown = condition("A", "eq", 1); for (let index = 0; index < 5_000; index++) nested = { kind: "group", operator: "and", conditions: [nested] };
    expect(() => definition([{ type: "filter", condition: nested }])).toThrow(/twelve/);
  });
  it("validates required quality/condition settings and accepts a reused non-cyclic condition leaf", () => {
    for (const kind of ["type", "range", "length", "regex", "allowed", "compare"]) expect(() => definition([quality([{ kind }])])).toThrow();
    expect(() => definition([{ type: "filter", condition: condition("A", "between", 1) }])).toThrow("upper");
    const leaf = condition("A", "eq", 1);
    expect(() => definition([{ type: "filter", condition: { kind: "group", operator: "and", conditions: [leaf, leaf] } }])).not.toThrow();
  });
  it("keeps only the last fifty undo entries and clears redo after a new edit", () => {
    let history = createPipelineHistory(defaultPipeline("main"));
    for (let index = 0; index < 55; index++) history = pipelineHistoryReducer(history, { type: "set", definition: { ...history.present, options: { ...history.present.options, maxMaterializedRows: index + 1 } } });
    expect(history.past).toHaveLength(50); history = pipelineHistoryReducer(history, { type: "undo" }); expect(history.future).toHaveLength(1);
    history = pipelineHistoryReducer(history, { type: "set", definition: defaultPipeline("other") }); expect(history.future).toHaveLength(0);
  });
  it("encodes prepared CSV with exact header order, escaped commas, UTF-8 and LF", async () => {
    expect(new TextDecoder().decode(encodeCsvRow(['A,B', 'a"b', "Café\r\nNext", null]))).toBe('"A,B","a""b","Café\nNext",\n');
    const chunks = []; for await (const chunk of rowsToCsv(["B", "A"], source("s", [{ A: 1, B: 2 }]).open())) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("B,A\n2,1\n");
  });
  it("prepares the real Superstore sample identically in preview/full-run mode, removing three exact Order ID duplicates", async () => {
    const sample = parse(readFileSync("samples/superstore_sales.csv"), { columns: true }) as PrepareRow[];
    // The shared SQL fixture has 2,000 unique rows; add the three intended
    // duplicate source records without changing other phases' sample data.
    const rows = [...sample, ...sample.slice(0, 3).map((row) => ({ ...row }))];
    const steps = [{ type: "cleanText", columns: ["Customer Name"], operations: ["trim", "collapse"] }, { type: "derive", column: "Profit Margin", expression: "TONUMBER([Profit]) / TONUMBER([Sales])" }, { type: "filter", condition: condition("Quantity", "empty"), mode: "drop" }, { type: "dedupe", columns: ["Order ID"], keep: "first" }];
    const full = await run(rows, steps); expect(full.summary.rowsRead).toBe(2_003); expect(full.output).toHaveLength(2_000); expect(full.summary.steps.at(-1)?.removed).toBe(3);
    const preview = await run(rows, steps, [], { sourceLimit: 1_000 }); expect(preview.output).toEqual((await run(rows.slice(0, 1_000), steps)).output);
    expect(full.columns).toContain("Profit Margin"); expect(full.output[1]["Profit Margin"]).toEqual(expect.any(Number));
  });
});
