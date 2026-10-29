import type { QueryValue } from "@/lib/semantic/query/types";
import type { ReportConditionalFormat } from "./schema";

export interface ReportCellStyle { color?: string; bold?: boolean }

/** Rules only inspect numeric results; their values never become SQL or HTML. */
export function conditionalStyle(value: QueryValue | undefined, measure: string, rules: readonly ReportConditionalFormat[]): ReportCellStyle {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return {};
  const numeric = typeof value === "number" ? value : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(numeric)) return {};
  const style: ReportCellStyle = {};
  for (const rule of rules) {
    if (rule.measure !== measure || !(rule.op === "gt" ? numeric > rule.value : numeric < rule.value)) continue;
    if (rule.color) style.color = rule.color;
    if (rule.bold) style.bold = true;
  }
  return style;
}
