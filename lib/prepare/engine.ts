import { setImmediate as yieldToNode } from "node:timers/promises";
import { compileRowExpression } from "./expression";
import { convertCell } from "./conversion";
import { compileSafeRegex, type SafeRegex } from "./safe-regex";
import { analyzePipeline } from "./lineage";
import { pipelineDefinitionSchema, type Cell, type PipelineDefinition, type PrepareCondition, type PrepareRow, type PrepareStep, type QualityRule } from "./schema";
import type { EngineOptions, EngineSource, PipelineExecution, PipelineSummary, RuleSummary, StepSummary } from "./types";

export class MemoryBudgetError extends Error { constructor(public summary: PipelineSummary) { super("This preparation step exceeded its memory or materialized-row budget. Reduce source columns, use a smaller lookup, or raise the pipeline budget."); this.name = "MemoryBudgetError"; } }
export class QualityThresholdError extends Error {
  constructor(public summary: PipelineSummary, public stepId: string, public ruleName: string, public ratePct: number, public thresholdPct: number) {
    super(`Quality rule “${ruleName}” failed for ${ratePct.toFixed(2)}% of rows, exceeding its ${thresholdPct}% threshold. SQL loading has not started.`); this.name = "QualityThresholdError";
  }
}
interface Entry { row: PrepareRow; original: PrepareRow; rowNumber: number; sourceId: string; order: number }
const empty = (value: Cell | undefined) => value === null || value === undefined || typeof value === "string" && value.trim() === "";
const cloneRow = (row: PrepareRow): PrepareRow => Object.assign(Object.create(null) as PrepareRow, row);
const changed = (entry: Entry, row: PrepareRow): Entry => ({ ...entry, row });
const canonicalKey = (row: PrepareRow, columns: string[], skipEmpty = false) => {
  const values = columns.map((column) => row[column]);
  return skipEmpty && values.some(empty) ? null : JSON.stringify(values.map((value) => value === null || value === undefined ? null : String(value)));
};
function compare(left: Cell | undefined, right: Cell | undefined): number {
  if (left === right) return 0;
  if (empty(left)) return empty(right) ? 0 : -1;
  if (empty(right)) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "en-US");
}
function cellBytes(row: PrepareRow): number { let bytes = 64; for (const [key, value] of Object.entries(row)) bytes += 32 + key.length * 2 + (typeof value === "string" ? value.length * 2 : 8); return bytes; }
class Budget {
  bytes = 0; rows = 0;
  constructor(private bytesLimit: number, private rowsLimit: number, private summary: PipelineSummary) {}
  reserve(bytes: number, rows = 1) { this.bytes += bytes; this.rows += rows; if (this.bytes > this.bytesLimit || this.rows > this.rowsLimit) { this.bytes -= bytes; this.rows -= rows; throw new MemoryBudgetError(this.summary); } }
  release(bytes: number, rows = 1) { this.bytes -= bytes; this.rows -= rows; }
  lease() { let bytes = 0, rows = 0; return { reserve: (size: number, count = 1) => { this.reserve(size, count); bytes += size; rows += count; }, replace: (before: number, after: number) => { this.release(before, 0); bytes -= before; this.reserve(after, 0); bytes += after; }, close: () => { this.release(bytes, rows); bytes = 0; rows = 0; } }; }
}
interface Runtime {
  step: PrepareStep; summary: StepSummary; hasRegex: boolean;
  transform?: (entry: Entry, signal: AbortSignal) => Entry[] | Promise<Entry[]>;
  materialize?: (input: AsyncIterable<Entry>) => AsyncGenerator<Entry>;
  finish?: () => void | Promise<void>;
}

/** Compiles definitions once, then opens sources only when the result is pulled. */
export async function executePipeline(input: PipelineDefinition, sources: readonly EngineSource[], options: EngineOptions = {}): Promise<PipelineExecution> {
  const definition = pipelineDefinitionSchema.parse(input);
  const maxOutputRows = options.maxOutputRows ?? 5_000_000;
  if (!Number.isInteger(maxOutputRows) || maxOutputRows < 1 || maxOutputRows > 5_000_000) throw new Error("Choose an output row limit between 1 and 5,000,000.");
  if (options.sourceLimit !== undefined && (!Number.isInteger(options.sourceLimit) || options.sourceLimit < 1 || options.sourceLimit > 5_000_000)) throw new Error("Choose a source sample size between 1 and 5,000,000 rows.");
  if (options.stopAfterStep !== undefined && (!Number.isInteger(options.stopAfterStep) || options.stopAfterStep < -1 || options.stopAfterStep >= definition.steps.length)) throw new Error("Choose an existing pipeline preview step.");
  const analysis = analyzePipeline(definition, sources, options.stopAfterStep);
  if (!analysis.valid) throw new Error(analysis.errors.map((issue) => issue.message).join(" "));
  const summary: PipelineSummary = { rowsRead: 0, rowsOut: 0, rowsRejected: 0, steps: [], rules: [], warnings: [] };
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const budget = new Budget(definition.options.memoryMb * 1024 * 1024, definition.options.maxMaterializedRows, summary);
  const regexes: SafeRegex[] = [];
  const regex = async (pattern: string, flags = "") => {
    const compiled = await compileSafeRegex(pattern, flags); regexes.push(compiled);
    // Warm the bounded worker before starting a row's 100ms deadline. Startup
    // and admission to the shared pool are not regex execution time.
    await compiled.test("", signal); return compiled;
  };
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const allColumns = [...new Set([...sources.flatMap((source) => source.columns), ...analysis.columns, ...definition.steps.flatMap((step) => step.type === "derive" ? [step.column] : step.type === "select" ? step.columns.map((column) => column.rename ?? column.name) : step.type === "split" ? step.outputColumns : step.type === "merge" ? [step.column] : step.type === "join" ? step.columns.map((column) => column.target) : step.type === "unpivot" ? [step.nameColumn, step.valueColumn] : [])])];
  let sequence = 0;
  const progress = async () => { signal.throwIfAborted(); if (options.onProgress) await options.onProgress(summary); };
  async function* sourceRows(sourceId: string): AsyncGenerator<Entry> {
    signal.throwIfAborted(); const source = sourceById.get(sourceId)!;
    const iterator = source.open({ limit: options.sourceLimit, signal })[Symbol.asyncIterator]();
    let rowNumber = 0;
    try {
      while (rowNumber < (options.sourceLimit ?? 5_000_000)) {
        signal.throwIfAborted(); const next = await iterator.next(); if (next.done) return;
        const original = cloneRow(next.value); rowNumber++; summary.rowsRead++;
        yield { row: cloneRow(original), original, rowNumber, sourceId, order: sequence++ };
        if (summary.rowsRead % 5_000 === 0) { await progress(); await yieldToNode(); }
      }
      if (options.sourceLimit === undefined && !(await iterator.next()).done) throw new Error("A preparation source exceeds 5,000,000 rows. Split it into smaller files.");
    } finally { if (iterator.return) await iterator.return(); }
  }
  async function reject(entry: Entry, runtime: Runtime, reason: string, bucket?: string, count = true): Promise<void> {
    if (count) { runtime.summary.rowsRejected++; summary.rowsRejected++; }
    if (options.onReject) await options.onReject({ stepId: runtime.step.id, stepName: runtime.step.name || runtime.step.type, ruleName: reason, bucket, rowNumber: entry.rowNumber, values: cloneRow(entry.original) });
  }
  async function compileCondition(condition: PrepareCondition): Promise<{ test: (row: PrepareRow, signal: AbortSignal) => boolean | Promise<boolean>; hasRegex: boolean }> {
    if (condition.kind === "group") {
      const children = await Promise.all(condition.conditions.map(compileCondition));
      return { hasRegex: children.some((child) => child.hasRegex), test: async (row, rowSignal) => {
        for (const child of children) { const matches = await child.test(row, rowSignal); if (condition.operator === "and" && !matches) return false; if (condition.operator === "or" && matches) return true; }
        return condition.operator === "and";
      } };
    }
    if (condition.operator === "regex") {
      const compiled = await regex(condition.pattern ?? String(condition.value ?? ""));
      return { hasRegex: true, test: (row, rowSignal) => compiled.test(String(row[condition.column] ?? ""), rowSignal) };
    }
    return { hasRegex: false, test: (row) => {
      const value = row[condition.column] ?? null, expected = condition.value ?? null;
      switch (condition.operator) {
        case "eq": return value === expected || !empty(value) && !empty(expected) && String(value) === String(expected);
        case "ne": return !(value === expected || !empty(value) && !empty(expected) && String(value) === String(expected));
        case "empty": return empty(value);
        case "contains": return !empty(value) && String(value).includes(String(expected ?? ""));
        case "starts": return !empty(value) && String(value).startsWith(String(expected ?? ""));
        case "ends": return !empty(value) && String(value).endsWith(String(expected ?? ""));
        case "in": return (condition.values ?? []).some((candidate) => candidate === value || candidate !== null && value !== null && String(candidate) === String(value));
        case "gt": return !empty(value) && !empty(expected) && compareNumeric(value, expected) > 0;
        case "lt": return !empty(value) && !empty(expected) && compareNumeric(value, expected) < 0;
        case "between": return !empty(value) && !empty(expected) && !empty(condition.upper) && compareNumeric(value, expected) >= 0 && compareNumeric(value, condition.upper!) <= 0;
        default: return false;
      }
    } };
  }
  const runtimes: Runtime[] = [];
  try {
    for (const [index, step] of definition.steps.entries()) {
      if (options.stopAfterStep !== undefined && index > options.stopAfterStep) break;
      if (!step.enabled) continue;
      const stats: StepSummary = { id: step.id, name: step.name || step.type, type: step.type, rowsIn: 0, rowsOut: 0, rowsRejected: 0, removed: 0, ruleCounts: [] };
      summary.steps.push(stats);
      const runtime: Runtime = { step, summary: stats, hasRegex: false };
      runtimes.push(runtime);
      switch (step.type) {
        case "select": runtime.transform = (entry) => [changed(entry, Object.fromEntries(step.columns.map((column) => [column.rename ?? column.name, entry.row[column.name] ?? null])))]; break;
        case "drop": runtime.transform = (entry) => [changed(entry, Object.fromEntries(Object.entries(entry.row).filter(([name]) => !step.columns.includes(name))))]; break;
        case "changeType": runtime.transform = async (entry) => {
          const row = cloneRow(entry.row);
          for (const column of step.columns) try { row[column.column] = convertCell(row[column.column] ?? null, column.type, column.pattern); }
          catch (error) { if (step.onError === "null") row[column.column] = null; else if (step.onError === "reject") { await reject(entry, runtime, `Invalid ${column.type} in ${column.column}: ${error instanceof Error ? error.message : "conversion failed"}`); return []; } }
          return [changed(entry, row)];
        }; break;
        case "cleanText": runtime.transform = (entry) => {
          const row = cloneRow(entry.row);
          for (const column of step.columns) if (row[column] !== null && row[column] !== undefined) {
            let text = String(row[column]);
            for (const operation of step.operations) {
              if (operation === "trim") text = text.trim();
              else if (operation === "collapse") text = text.replace(/\s+/g, " ");
              else if (operation === "upper") text = text.toLocaleUpperCase("en-US");
              else if (operation === "lower") text = text.toLocaleLowerCase("en-US");
              else if (operation === "title") text = text.toLocaleLowerCase("en-US").replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase("en-US"));
              else if (operation === "nonPrinting") text = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
              else if (operation === "accents") text = text.normalize("NFD").replace(/\p{M}/gu, "");
            }
            row[column] = text;
          }
          return [changed(entry, row)];
        }; break;
        case "replace": {
          const replacements = new Map(step.map?.map((entry) => [JSON.stringify(entry.from), entry.to]));
          const compiled = step.regex && step.find !== undefined ? await regex(step.find, step.flags) : undefined;
          runtime.hasRegex = !!compiled;
          runtime.transform = async (entry, rowSignal) => {
            const row = cloneRow(entry.row), value = row[step.column] ?? null, exact = JSON.stringify(value);
            if (replacements.has(exact)) row[step.column] = replacements.get(exact)!;
            else if (compiled && !empty(value)) row[step.column] = await compiled.replace(String(value), step.replacement, rowSignal);
            else if (!step.regex && step.find && !empty(value)) row[step.column] = String(value).replaceAll(step.find, step.replacement);
            return [changed(entry, row)];
          }; break;
        }
        case "fill": {
          if (step.mode === "mean" || step.mode === "median") {
            runtime.materialize = async function* (entries) {
              const lease = budget.lease(), rows: Entry[] = [];
              try {
                for await (const entry of entries) { lease.reserve(entryBytes(entry)); rows.push(entry); }
                const averages = new Map<string, number | null>();
                for (const column of step.columns) {
                  lease.reserve(rows.length * 8, 0);
                  const values: number[] = [];
                  for (const entry of rows) { const value = entry.row[column]; if (!empty(value) && typeof value !== "boolean") { const numeric = Number(value); if (Number.isFinite(numeric)) values.push(numeric); } }
                  if (step.mode === "median") values.sort((a, b) => a - b);
                  const middle = Math.floor(values.length / 2);
                  averages.set(column, values.length ? step.mode === "mean" ? values.reduce((mean, value, index) => mean / (index + 1) * index + value / (index + 1), 0) : values.length % 2 ? values[middle] : values[middle - 1] / 2 + values[middle] / 2 : null);
                  lease.replace(rows.length * 8, 0);
                }
                for (const entry of rows) { const row = cloneRow(entry.row); for (const column of step.columns) if (empty(row[column])) row[column] = averages.get(column) ?? null; yield changed(entry, row); }
              } finally { lease.close(); }
            };
          } else {
            const previous = new Map<string, Cell>();
            runtime.transform = (entry) => { const row = cloneRow(entry.row); for (const column of step.columns) { if (empty(row[column])) row[column] = step.mode === "constant" ? step.value ?? null : previous.get(column) ?? null; if (!empty(row[column])) previous.set(column, row[column]); } return [changed(entry, row)]; };
          }
          break;
        }
        case "filter": case "conditionalSplit": {
          const predicate = await compileCondition(step.condition); runtime.hasRegex = predicate.hasRegex;
          runtime.transform = async (entry, rowSignal) => {
            const matches = await predicate.test(entry.row, rowSignal);
            const keep = step.type === "conditionalSplit" ? !matches : step.mode === "keep" ? matches : !matches;
            if (keep) return [entry];
            if (step.type === "conditionalSplit") await reject(entry, runtime, `Routed to ${step.bucket}`, step.bucket);
            else stats.removed++;
            return [];
          }; break;
        }
        case "derive": {
          const expression = compileRowExpression(step.expression, allColumns);
          runtime.transform = async (entry) => {
            const row = cloneRow(entry.row);
            try { row[step.column] = expression(row); }
            catch (error) { if (step.onError === "null") row[step.column] = null; else if (step.onError === "keep") row[step.column] ??= null; else { await reject(entry, runtime, `Expression for ${step.column}: ${error instanceof Error ? error.message : "could not be evaluated"}`); return []; } }
            return [changed(entry, row)];
          }; break;
        }
        case "split": runtime.transform = (entry) => {
          const row = cloneRow(entry.row), value = entry.row[step.column];
          if (step.dropOriginal) delete row[step.column];
          let parts: string[] = [];
          if (!empty(value)) {
            const text = String(value);
            if (step.mode === "delimiter") { parts = text.split(step.delimiter!); if (parts.length > step.outputColumns.length) parts = [...parts.slice(0, step.outputColumns.length - 1), parts.slice(step.outputColumns.length - 1).join(step.delimiter)]; }
            else { let offset = 0; parts = step.outputColumns.map((_, index) => { const width = step.widths?.[index]; const part = width === undefined ? text.slice(offset) : text.slice(offset, offset + width); offset += width ?? text.length; return part; }); }
          }
          step.outputColumns.forEach((column, index) => { row[column] = parts[index] ?? null; });
          return [changed(entry, row)];
        }; break;
        case "merge": runtime.transform = (entry) => { const row = cloneRow(entry.row); const value = step.columns.map((column) => row[column] ?? "").join(step.separator); if (step.dropOriginal) step.columns.forEach((column) => delete row[column]); row[step.column] = value; return [changed(entry, row)]; }; break;
        case "dedupe": {
          const lease = budget.lease();
          if (step.keep === "first") {
            const keys = new Set<string>();
            runtime.transform = (entry) => { const key = canonicalKey(entry.row, step.columns)!; if (keys.has(key)) { stats.removed++; return []; } lease.reserve(64 + key.length * 2); keys.add(key); return [entry]; };
            runtime.finish = () => { keys.clear(); lease.close(); };
          } else runtime.materialize = async function* (entries) {
            const kept = new Map<string, Entry>();
            try {
              for await (const entry of entries) {
                const key = canonicalKey(entry.row, step.columns)!, prior = kept.get(key);
                if (!prior) { lease.reserve(entryBytes(entry) + key.length * 2); kept.set(key, entry); }
                else {
                  stats.removed++;
                  const comparison = compareNumeric(entry.row[step.valueColumn!] ?? null, prior.row[step.valueColumn!] ?? null);
                  if (step.keep === "last" || step.keep === "max" && comparison > 0 || step.keep === "min" && comparison < 0) { lease.replace(entryBytes(prior), entryBytes(entry)); kept.set(key, entry); }
                }
              }
              for (const entry of [...kept.values()].sort((a, b) => a.order - b.order)) yield entry;
            } finally { kept.clear(); lease.close(); }
          };
          break;
        }
        case "join": runtime.materialize = async function* (entries) {
          const lease = budget.lease(), lookup = new Map<string, { row: PrepareRow; multiple: boolean }>();
          try {
            for await (const entry of sourceRows(step.sourceId)) {
              const key = canonicalKey(entry.row, step.keys.map((key) => key.right), true); if (key === null) continue;
              const prior = lookup.get(key);
              if (prior) prior.multiple = true;
              else { const row = Object.fromEntries(step.columns.map((column) => [column.source, entry.row[column.source] ?? null])); lease.reserve(cellBytes(row) + key.length * 2 + 32); lookup.set(key, { row, multiple: false }); }
            }
            for await (const entry of entries) {
              const key = canonicalKey(entry.row, step.keys.map((key) => key.left), true);
              const match = key === null ? undefined : lookup.get(key);
              if (match?.multiple && step.multiple === "error") throw new Error(`Lookup “${step.name || step.id}” has multiple matches for a main-row key. Deduplicate the lookup or choose first/reject.`);
              if (match?.multiple && step.multiple === "reject") { await reject(entry, runtime, "Lookup key has multiple matches"); continue; }
              if (!match && step.kind === "inner") { stats.removed++; continue; }
              const row = cloneRow(entry.row); step.columns.forEach((column) => { row[column.target] = match?.row[column.source] ?? null; }); yield changed(entry, row);
            }
          } finally { lookup.clear(); lease.close(); }
        }; break;
        case "union": runtime.materialize = async function* (entries) {
          const lease = budget.lease(), appended: Entry[] = [];
          try {
            for await (const entry of sourceRows(step.sourceId)) { lease.reserve(entryBytes(entry)); appended.push(entry); }
            const before = analyzePipeline(definition, sources, index - 1).columns;
            const mapping = step.mappings ?? before.map((column) => ({ source: column, target: column }));
            for await (const entry of entries) yield entry;
            for (const entry of appended) {
              const row = Object.fromEntries(before.map((column) => [column, null])) as PrepareRow;
              for (const column of mapping) row[column.target] = entry.row[column.source] ?? null;
              stats.rowsIn++; yield changed(entry, row);
            }
          } finally { lease.close(); }
        }; break;
        case "unpivot": runtime.materialize = async function* (entries) {
          const selected = new Set(step.columns);
          let expanded = 0;
          for await (const entry of entries) {
            const retained = Object.fromEntries(Object.entries(entry.row).filter(([name]) => !selected.has(name))) as PrepareRow;
            for (const column of step.columns) {
              signal.throwIfAborted();
              if (expanded >= maxOutputRows) throw new Error(`Prepared output exceeds ${maxOutputRows.toLocaleString("en-US")} rows. Reduce unpivot/append expansion or filter before unpivot.`);
              const row = cloneRow(retained); row[step.nameColumn] = column; row[step.valueColumn] = entry.row[column] ?? null;
              expanded++; yield changed(entry, row);
              // Downstream filters may discard every row; fan-out must still
              // yield so HTTP cancellation can run and limits cannot be bypassed.
              if (expanded % 5_000 === 0) { await progress(); await yieldToNode(); }
            }
          }
        }; break;
        case "sort": runtime.materialize = async function* (entries) {
          const lease = budget.lease(), rows: Entry[] = [];
          try { for await (const entry of entries) { lease.reserve(entryBytes(entry)); rows.push(entry); } rows.sort((a, b) => { for (const column of step.columns) { const result = compare(a.row[column.column], b.row[column.column]); if (result) return column.dir === "asc" ? result : -result; } return a.order - b.order; }); for (const entry of rows) yield entry; }
          finally { lease.close(); }
        }; break;
        case "quality": {
          const checks: { rule: QualityRule; stats: RuleSummary; check: (row: PrepareRow, signal: AbortSignal) => boolean | Promise<boolean>; lease?: ReturnType<Budget["lease"]> }[] = [];
          for (const rule of step.rules) {
            const ruleStats: RuleSummary = { id: rule.id, name: rule.name, severity: rule.severity, checked: 0, failed: 0, ratePct: 0 };
            stats.ruleCounts.push(ruleStats); summary.rules.push(ruleStats);
            let check: (row: PrepareRow, signal: AbortSignal) => boolean | Promise<boolean>;
            let lease: ReturnType<Budget["lease"]> | undefined;
            if (rule.kind === "unique") {
              const keys = new Set<string>(); lease = budget.lease();
              check = (row) => { if (empty(row[rule.column])) return true; const key = canonicalKey(row, [rule.column])!; if (keys.has(key)) return false; lease!.reserve(64 + key.length * 2); keys.add(key); return true; };
            } else if (rule.kind === "regex") { const compiled = await regex(rule.pattern ?? ""); runtime.hasRegex = true; check = (row, rowSignal) => empty(row[rule.column]) || compiled.test(String(row[rule.column]), rowSignal); }
            else check = (row) => validQuality(row, rule);
            checks.push({ rule, stats: ruleStats, check, lease });
          }
          runtime.transform = async (entry, rowSignal) => {
            let rejected = false;
            for (const check of checks) {
              check.stats.checked++;
              if (await check.check(entry.row, rowSignal)) continue;
              check.stats.failed++; check.stats.ratePct = check.stats.failed / check.stats.checked * 100;
              if (check.rule.severity === "reject") { await reject(entry, runtime, check.rule.name, undefined, !rejected); rejected = true; }
              else if (check.rule.severity === "fail") await reject(entry, runtime, check.rule.name, undefined, false);
            }
            return rejected ? [] : [entry];
          };
          runtime.finish = () => {
            checks.forEach((check) => { check.lease?.close(); check.stats.ratePct = check.stats.checked ? check.stats.failed / check.stats.checked * 100 : 0; });
            const failed = checks.find((check) => check.rule.severity === "fail" && check.stats.ratePct > check.rule.thresholdPct);
            if (failed) throw new QualityThresholdError(summary, step.id, failed.rule.name, failed.stats.ratePct, failed.rule.thresholdPct);
          };
          break;
        }
      }
    }
  } catch (error) { await Promise.allSettled(regexes.map((compiled) => compiled.close())); throw error; }
  async function* through(input: AsyncIterable<Entry>, runtime: Runtime): AsyncGenerator<Entry> {
    const counted = (async function* () { for await (const entry of input) { signal.throwIfAborted(); runtime.summary.rowsIn++; entry.order = runtime.summary.rowsIn; yield entry; } })();
    try {
      if (runtime.materialize) for await (const entry of runtime.materialize(counted)) { signal.throwIfAborted(); runtime.summary.rowsOut++; yield entry; }
      else for await (const entry of counted) {
        signal.throwIfAborted();
        const rowSignal = runtime.hasRegex ? AbortSignal.any([signal, AbortSignal.timeout(100)]) : signal;
        for (const result of await runtime.transform!(entry, rowSignal)) { runtime.summary.rowsOut++; yield result; }
      }
      await runtime.finish?.();
      await progress();
    } finally { if (runtime.summary.rowsIn && runtime.step.type === "dedupe" && runtime.step.keep === "first") await runtime.finish?.(); }
  }
  let rows: AsyncIterable<Entry> = sourceRows(definition.mainSourceId);
  for (const runtime of runtimes) rows = through(rows, runtime);
  let completed = false;
  const result = (async function* () {
    try {
      for await (const entry of rows) {
        signal.throwIfAborted();
        if (summary.rowsOut >= maxOutputRows) throw new Error(`Prepared output exceeds ${maxOutputRows.toLocaleString("en-US")} rows. Reduce unpivot/append expansion or add a filter.`);
        summary.rowsOut++; yield entry.row;
        if (summary.rowsOut % 5_000 === 0) { await progress(); await yieldToNode(); }
      }
      completed = true; await progress();
    }
    finally { await Promise.allSettled(regexes.map((compiled) => compiled.close())); }
  })();
  return { rows: result, columns: analysis.columns, summary, close: async () => { if (!completed) abort.abort(); await result.return(undefined); await Promise.allSettled(regexes.map((compiled) => compiled.close())); } };
}
function compareNumeric(left: Cell, right: Cell): number {
  const a = !empty(left) && typeof left !== "boolean" ? Number(left) : NaN, b = !empty(right) && typeof right !== "boolean" ? Number(right) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : compare(left, right);
}
function entryBytes(entry: Entry): number { return cellBytes(entry.row) + cellBytes(entry.original) + 80; }
function validQuality(row: PrepareRow, rule: QualityRule): boolean {
  const value = row[rule.column] ?? null;
  if (rule.kind === "notNull") return !empty(value);
  if (empty(value)) return true;
  if (rule.kind === "type") { try { convertCell(value, rule.valueType ?? "text", rule.pattern); return true; } catch { return false; } }
  if (rule.kind === "range") return (rule.min === undefined || compareNumeric(value, rule.min) >= 0) && (rule.max === undefined || compareNumeric(value, rule.max) <= 0);
  if (rule.kind === "length") { const length = String(value).length; return (rule.minLength === undefined || length >= rule.minLength) && (rule.maxLength === undefined || length <= rule.maxLength); }
  if (rule.kind === "allowed") return (rule.values ?? []).some((allowed) => allowed === value || allowed !== null && String(allowed) === String(value));
  if (rule.kind === "compare") {
    const other = row[rule.otherColumn ?? ""] ?? null; if (empty(other)) return false;
    const comparison = compareNumeric(value, other);
    return rule.comparison === "ne" ? comparison !== 0 : rule.comparison === "gt" ? comparison > 0 : rule.comparison === "gte" ? comparison >= 0 : rule.comparison === "lt" ? comparison < 0 : rule.comparison === "lte" ? comparison <= 0 : comparison === 0;
  }
  return true;
}
