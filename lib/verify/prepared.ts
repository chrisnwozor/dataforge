import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import type {
  PreparedColumnReference,
  PreparedReference,
  VerificationColumn,
} from "./types";

const DEFAULT_MEMORY = 150 * 1024 * 1024;
const MAX_RETAINED = 500_000;
const MAX_COLUMNS = 10_000;
const budgetAdvice =
  "Reduce the number of columns, split the source, or use a smaller prepared dataset; exact checks never substitute sampled or estimated counts.";

export class PreparedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedReferenceError";
  }
}
interface Decimal {
  units: bigint;
  scale: number;
}
interface State {
  definition: VerificationColumn;
  nulls: number;
  count: number;
  invalid: number;
  min: string | number | null;
  max: string | number | null;
  total: Decimal;
  values: Set<string>;
  unsafeNumeric: boolean;
}
const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const groupedPattern = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/** Independent decimal arithmetic. No profiler, prepare engine, or SQL-generator helper is used. */
function decimal(value: string, integer: boolean): Decimal | null {
  const plain = groupedPattern.test(value) ? value.replaceAll(",", "") : value;
  if (
    plain.length > 256 ||
    !decimalPattern.test(plain) ||
    (integer && !/^[+-]?\d+$/.test(plain))
  )
    return null;
  const [mantissa, exponentText = "0"] = plain.toLowerCase().split("e");
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  const sign = mantissa.startsWith("-") ? -BigInt(1) : BigInt(1);
  const unsigned = mantissa.replace(/^[+-]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  let units = BigInt((whole || "0") + fraction) * sign;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= BigInt(10) ** BigInt(-scale);
    scale = 0;
  }
  if (scale > 100) return null;
  while (scale && units % BigInt(10) === BigInt(0)) {
    units /= BigInt(10);
    scale--;
  }
  return { units, scale };
}
function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    units:
      left.units * BigInt(10) ** BigInt(scale - left.scale) +
      right.units * BigInt(10) ** BigInt(scale - right.scale),
    scale,
  };
}
function decimalKey(value: Decimal): string {
  return `${value.units.toString()}:${value.scale}`;
}
function numberValue(value: Decimal): number {
  return Number(value.units) / 10 ** value.scale;
}
function dateValue(value: string): string | null {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    );
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !us) return null;
  const year = Number(iso ? iso[1] : us![3]),
    month = Number(iso ? iso[2] : us![1]),
    day = Number(iso ? iso[3] : us![2]);
  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    (iso?.[4] &&
      (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59))
  )
    return null;
  const check = new Date(0);
  check.setUTCHours(0, 0, 0, 0);
  check.setUTCFullYear(year, month - 1, day);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  )
    return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function initial(
  definition: VerificationColumn,
  values = new Set<string>(),
): State {
  return {
    definition,
    nulls: 0,
    count: 0,
    invalid: 0,
    min: null,
    max: null,
    total: { units: BigInt(0), scale: 0 },
    values,
    unsafeNumeric: false,
  };
}
function observe(
  state: State,
  value: string | null,
  retain?: (set: Set<string>, value: string) => void,
): string | null {
  if (value === null) {
    state.nulls++;
    return null;
  }
  let normalized: string | number = value;
  let key = value;
  if (
    state.definition.type === "integer" ||
    state.definition.type === "decimal"
  ) {
    const parsed = decimal(value, state.definition.type === "integer");
    if (!parsed) {
      state.invalid++;
      retain?.(state.values, `invalid:${value}`);
      return `invalid:${value}`;
    }
    const number = numberValue(parsed);
    if (!Number.isFinite(number)) {
      state.invalid++;
      retain?.(state.values, `invalid:${value}`);
      return `invalid:${value}`;
    }
    if (
      Math.abs(number) > Number.MAX_SAFE_INTEGER ||
      (parsed.scale > 0 && Math.abs(number) >= 100_000_000_000_000)
    )
      state.unsafeNumeric = true;
    state.count++;
    state.total = add(state.total, parsed);
    normalized = number;
    key = decimalKey(parsed);
  } else if (state.definition.type === "date") {
    const parsed = dateValue(value);
    if (!parsed) {
      state.invalid++;
      retain?.(state.values, `invalid:${value}`);
      return `invalid:${value}`;
    }
    normalized = parsed;
    key = parsed;
  } else if (state.definition.type === "boolean") {
    const lower = value.toLowerCase();
    if (["true", "yes", "1"].includes(lower)) {
      normalized = "true";
      key = "true";
    } else if (["false", "no", "0"].includes(lower)) {
      normalized = "false";
      key = "false";
    } else {
      state.invalid++;
      retain?.(state.values, `invalid:${value}`);
      return `invalid:${value}`;
    }
  }
  retain?.(state.values, key);
  if (state.min === null || normalized < state.min) state.min = normalized;
  if (state.max === null || normalized > state.max) state.max = normalized;
  return key;
}
function output(state: State): PreparedColumnReference {
  const numeric =
    state.definition.type === "integer" || state.definition.type === "decimal";
  const sum = numberValue(state.total);
  if (!Number.isFinite(sum))
    throw new PreparedReferenceError(
      `The independent SUM for ${JSON.stringify(state.definition.name)} exceeds the finite numeric range. ${budgetAdvice}`,
    );
  return {
    name: state.definition.name,
    type: state.definition.type,
    nulls: state.nulls,
    distinct: state.values.size,
    min: state.min,
    max: state.max,
    ...(numeric
      ? {
          numeric: {
            count: state.count,
            nulls: state.nulls,
            sum,
            min: typeof state.min === "number" ? state.min : null,
            max: typeof state.max === "number" ? state.max : null,
          },
        }
      : {}),
  };
}

export interface PreparedReferenceOptions {
  signal?: AbortSignal;
  memoryBytes?: number;
  /** Keys are caller-owned dimension identities; values are prepared column names. Null tuples are excluded. */
  dimensionTuples?: Record<string, string[]>;
}
/** A streaming, exact reference pass over the pinned prepared CSV, not the current pipeline. */
export async function computePreparedReference(
  filePath: string,
  columns: VerificationColumn[],
  options: PreparedReferenceOptions = {},
): Promise<PreparedReference> {
  const started = performance.now();
  options.signal?.throwIfAborted();
  if (
    !columns.length ||
    columns.length > MAX_COLUMNS ||
    new Set(columns.map((column) => column.name)).size !== columns.length ||
    new Set(columns.map((column) => column.id)).size !== columns.length
  )
    throw new PreparedReferenceError(
      "Prepared reference columns must have unique names and IDs, with one to 10000 columns.",
    );
  const maxBytes = options.memoryBytes ?? DEFAULT_MEMORY;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DEFAULT_MEMORY
  )
    throw new PreparedReferenceError(
      "The exact reference memory budget must be between 1 byte and 150 MiB.",
    );
  let bytes = columns.length * 256;
  const retain = (set: Set<string>, value: string) => {
    if (set.has(value)) return;
    if (set.size >= MAX_RETAINED || bytes + value.length * 2 + 96 > maxBytes)
      throw new PreparedReferenceError(
        `Exact prepared checks exceeded the ${maxBytes} byte / ${MAX_RETAINED} retained-value budget. ${budgetAdvice}`,
      );
    bytes += value.length * 2 + 96;
    set.add(value);
  };
  if (bytes > maxBytes)
    throw new PreparedReferenceError(
      `Prepared metadata exceeds the exact reference memory budget. ${budgetAdvice}`,
    );
  const all = columns.map((column) => initial(column)),
    unique = columns.map((column, index) => initial(column, all[index].values));
  const seenRows = new Set<string>();
  const names = new Map(columns.map((column, index) => [column.name, index]));
  const tupleSets = Object.entries(options.dimensionTuples ?? {}).map(
    ([name, fields]) => {
      if (!fields.length || fields.some((field) => !names.has(field)))
        throw new PreparedReferenceError(
          `Dimension tuple ${JSON.stringify(name)} refers to an unavailable prepared column.`,
        );
      return {
        name,
        indexes: fields.map((field) => names.get(field)!),
        seen: new Set<string>(),
      };
    },
  );
  if (tupleSets.length > MAX_COLUMNS)
    throw new PreparedReferenceError(
      "Choose at most 10000 dimension tuple references.",
    );
  const source = createReadStream(/* turbopackIgnore: true */ filePath, {
    highWaterMark: 64 * 1024,
  });
  const parser = parse({
    bom: true,
    columns: false,
    skip_empty_lines: false,
    relax_column_count: false,
    max_record_size: 4 * 1024 * 1024,
  });
  const onError = (error: Error) => parser.destroy(error);
  const abort = () => {
    const error =
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Prepared checks cancelled.", "AbortError");
    source.destroy(error);
    parser.destroy(error);
  };
  source.on("error", onError);
  options.signal?.addEventListener("abort", abort, { once: true });
  source.pipe(parser);
  let rows = 0,
    duplicateRows = 0,
    nullCells = 0,
    header = false;
  try {
    for await (const record of parser) {
      options.signal?.throwIfAborted();
      const fields = record as string[];
      if (!header) {
        header = true;
        if (
          fields.length !== columns.length ||
          fields.some((value, index) => value !== columns[index].name)
        )
          throw new PreparedReferenceError(
            "The pinned prepared CSV headers do not match the saved profile. Re-prepare and run a full load before checking.",
          );
        continue;
      }
      if (fields.length !== columns.length)
        throw new PreparedReferenceError(
          `Prepared row ${rows + 2} has an inconsistent column count.`,
        );
      rows++;
      const cells = fields.map((value) => value.trim() || null);
      const rowKey = JSON.stringify(cells);
      const repeated = seenRows.has(rowKey);
      if (repeated) duplicateRows++;
      else retain(seenRows, rowKey);
      const canonical = cells.map((value, index) => {
        if (value === null) nullCells++;
        const normalized = observe(all[index], value, retain);
        if (!repeated) observe(unique[index], value);
        return normalized;
      });
      for (const tuple of tupleSets) {
        const values = tuple.indexes.map((index) => canonical[index]);
        if (values.every((value) => value !== null))
          retain(tuple.seen, JSON.stringify(values));
      }
      if (rows % 5000 === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!header)
      throw new PreparedReferenceError(
        "The pinned prepared CSV is empty and has no header.",
      );
    const warnings = all.flatMap((state) => [
      ...(state.invalid
        ? [
            `Column ${JSON.stringify(state.definition.name)} contains ${state.invalid} non-empty value(s) invalid for its saved ${state.definition.type} type; typed aggregate checks for this column require reject-row reconciliation.`,
          ]
        : []),
      ...(state.unsafeNumeric ||
      Math.abs(numberValue(state.total)) > Number.MAX_SAFE_INTEGER
        ? [
            `Column ${JSON.stringify(state.definition.name)} exceeds exact JavaScript numeric precision; numeric comparisons for this column must be skipped rather than rounded into a passing result.`,
          ]
        : []),
    ]);
    return {
      rows,
      duplicateRows,
      uniqueRows: rows - duplicateRows,
      nullCells,
      columns: all.map(output),
      deduplicatedColumns: unique.map(output),
      distinctTuples: Object.fromEntries(
        tupleSets.map((tuple) => [tuple.name, tuple.seen.size]),
      ),
      elapsedMs: Math.max(0, performance.now() - started),
      warnings,
    };
  } catch (error) {
    if (options.signal?.aborted)
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Prepared checks cancelled.", "AbortError");
    if (error instanceof PreparedReferenceError) throw error;
    throw new PreparedReferenceError(
      `The independent prepared CSV pass failed: ${error instanceof Error ? error.message : "unreadable CSV"}`,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
    source.destroy();
    parser.destroy();
  }
}
