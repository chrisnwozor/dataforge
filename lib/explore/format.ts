import type { QueryValue } from "@/lib/semantic/query/types";
import type { MeasureFormat, SemanticColumn, SemanticType } from "@/lib/semantic/types";

export interface ValueFormat { type?: SemanticType; name?: string; format?: MeasureFormat | "auto" }

// Reuse locale formatters across virtual rows, chart ticks and tooltip renders.
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });
const decimals = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatValue(value: QueryValue | undefined, options: ValueFormat = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    const year = !options.format || options.format === "auto"
      ? Number.isInteger(value) && (/\byear\b/i.test(options.name ?? "") || (value >= 1900 && value <= 2200))
      : false;
    if (year) return String(value);
    if (options.format === "currency") return currency.format(value);
    if (options.format === "percent") return percent.format(value);
    if (options.format === "decimals") return decimals.format(value);
    return number.format(value);
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  return value;
}

export function formatMeasure(value: QueryValue | undefined, format: MeasureFormat | "auto" = "number"): string {
  // Tedious returns SQL BIGINT (including COUNT_BIG) as a string. Only measure
  // values are coerced: dimension members such as Year and codes keep their text.
  if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    const integer = BigInt(value);
    return format === "currency" ? currency.format(integer)
      : format === "percent" ? percent.format(integer)
        : format === "decimals" ? decimals.format(integer) : number.format(integer);
  }
  if (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? formatValue(numeric, { format: format === "auto" ? "number" : format }) : "—";
  }
  return formatValue(value, { format: format === "auto" ? "number" : format });
}

export function formatAttribute(value: QueryValue | undefined, column?: Pick<SemanticColumn, "name" | "type">): string {
  return formatValue(value, { name: column?.name, type: column?.type });
}
