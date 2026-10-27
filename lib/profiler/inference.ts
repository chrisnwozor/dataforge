import type { InferredType } from "./types";

export const TYPE_SAMPLE_LIMIT = 1_000;
const MATCH_THRESHOLD = 0.95;
const BOOLEAN_VALUES = new Map([
  ["true", 1],
  ["false", 0],
  ["yes", 1],
  ["no", 0],
]);

function ungroupNumber(value: string): string {
  return /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)
    ? value.replaceAll(",", "")
    : value;
}

export function integerValue(value: string): bigint | null {
  const normalized = ungroupNumber(value);
  if (!/^[+-]?\d+$/.test(normalized)) return null;
  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

export function decimalValue(value: string): number | null {
  const normalized = ungroupNumber(value);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))
    return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function booleanValue(value: string): number | null {
  return BOOLEAN_VALUES.get(value.toLowerCase()) ?? null;
}

/** Explicit ISO and US month/day/year formats; no locale-dependent Date.parse guessing. */
export function dateValue(value: string): number | null {
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      value,
    );
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!iso && !slash) return null;
  const year = Number(iso ? iso[1] : slash![3]);
  const month = Number(iso ? iso[2] : slash![1]);
  const day = Number(iso ? iso[3] : slash![2]);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31)
    return null;
  const midnight = Date.UTC(year, month - 1, day);
  const checked = new Date(midnight);
  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  )
    return null;
  if (!iso?.[4]) return midnight;
  if (Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59)
    return null;
  // Treat timestamps without an explicit zone as UTC so profiling is host-independent.
  const normalized = value.replace(" ", "T");
  const timestamp = Date.parse(
    /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`,
  );
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Infer from at most the first 1,000 non-empty values, requiring a 95% match. */
export function inferType(values: string[]): InferredType {
  const sample = values
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, TYPE_SAMPLE_LIMIT);
  if (sample.length === 0) return "text";
  const required = Math.ceil(sample.length * MATCH_THRESHOLD);
  const candidates: {
    type: InferredType;
    matches: (value: string) => boolean;
  }[] = [
    { type: "boolean", matches: (value) => booleanValue(value) !== null },
    { type: "integer", matches: (value) => integerValue(value) !== null },
    { type: "decimal", matches: (value) => decimalValue(value) !== null },
    { type: "date", matches: (value) => dateValue(value) !== null },
  ];
  for (const candidate of candidates) {
    let count = 0;
    for (const value of sample) if (candidate.matches(value)) count++;
    if (count >= required) return candidate.type;
  }
  return "text";
}
