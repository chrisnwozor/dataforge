import { createExpressionResolver, type ResolvedExpr } from "@/lib/semantic/expr";
import type { AttributeRef, QueryFilter } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";

export type KpiPeriod = "all" | "latestYear" | "latestQuarter" | "latestMonth";
export type CalendarPeriod = "year" | "quarter" | "month";
export interface CompleteKpiPeriod {
  start: string;
  end: string;
  label: string;
  previousLabel: string;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const daysInMonth = (year: number, month: number) => month === 2
  ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
  : [4, 6, 9, 11].includes(month) ? 30 : 31;
const iso = (year: number, month: number, day: number) => `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const label = (year: number, month: number, period: CalendarPeriod) => period === "year" ? String(year)
  : period === "quarter" ? `Q${Math.ceil(month / 3)} ${year}` : `${months[month - 1]} ${year}`;

function calendarDate(value: string): { year: number; month: number; day: number; date: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day, date: iso(year, month, day) };
}

/**
 * Select the newest observed calendar period closed by an explicit as-of date.
 * Missing sales on its final day do not make a historical period incomplete.
 * Omitting asOfDate treats the observation itself as the data watermark.
 */
export function latestCompletePeriod(latestDate: string, period: CalendarPeriod, asOfDate = latestDate): CompleteKpiPeriod | null {
  const latest = calendarDate(latestDate), asOf = calendarDate(asOfDate);
  if (!latest || !asOf) return null;
  // Future-dated facts cannot select a period that has not closed as of today.
  const anchor = latest.date <= asOf.date ? latest : asOf;
  const { year, month } = anchor;
  const width = period === "year" ? 12 : period === "quarter" ? 3 : 1;
  let firstMonth = (year - 1) * 12 + Math.floor((month - 1) / width) * width;
  const containingLastMonth = Math.floor((month - 1) / width) * width + width;
  if (iso(year, containingLastMonth, daysInMonth(year, containingLastMonth)) > asOf.date) firstMonth -= width;
  const previousMonth = firstMonth - width;
  if (previousMonth < 0) return null;
  const startYear = Math.floor(firstMonth / 12) + 1, startMonth = firstMonth % 12 + 1;
  const endYear = Math.floor((firstMonth + width - 1) / 12) + 1, endMonth = (firstMonth + width - 1) % 12 + 1;
  const previousYear = Math.floor(previousMonth / 12) + 1, previousStartMonth = previousMonth % 12 + 1;
  return {
    start: iso(startYear, startMonth, 1),
    end: iso(endYear, endMonth, daysInMonth(endYear, endMonth)),
    label: label(startYear, startMonth, period),
    previousLabel: label(previousYear, previousStartMonth, period),
  };
}

export function periodTypeForSelection(period: KpiPeriod | undefined): CalendarPeriod | null {
  return period === "latestYear" ? "year" : period === "latestQuarter" ? "quarter" : period === "latestMonth" ? "month" : null;
}

export function kpiDateAttribute(model: SemanticModel): AttributeRef | null {
  if (!model.date) return null;
  const table = model.tables.find((entry) => entry.id === model.date!.tableId && entry.kind === "dimension");
  const column = table?.columns.find((entry) => entry.id === model.date!.dateColumnId && entry.role === "attribute" && entry.type === "date");
  return table && column ? { table: table.id, column: column.id } : null;
}

/** Detect the time interval from the resolved measure, including nested references and renamed measures. */
export function comparisonPeriodType(model: SemanticModel, measureRef: string): CalendarPeriod | null {
  if (!kpiDateAttribute(model)) return null;
  const measure = model.measures.find((entry) => entry.id === measureRef || entry.name.toLocaleLowerCase("en-US") === measureRef.toLocaleLowerCase("en-US"));
  if (!measure) return null;
  const visited = new Set<ResolvedExpr>();
  const periods = new Set<CalendarPeriod>();
  const walk = (node: ResolvedExpr): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "call") {
      if (node.name === "SAMEPERIODLASTYEAR") periods.add("year");
      if (node.name === "PREVIOUSPERIOD" && node.args[1]?.kind === "period") periods.add(node.args[1].value.toLowerCase() as CalendarPeriod);
      node.args.forEach(walk);
    } else if (node.kind === "measure") walk(node.expression);
    else if (node.kind === "binary") { walk(node.left); walk(node.right); }
    else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "in") { walk(node.expression); node.values.forEach(walk); }
  };
  try { walk(createExpressionResolver(model).resolveMeasure(measure.id).ast); }
  catch { return null; }
  // A comparison mixing distinct offsets has no single truthful period label.
  if (periods.size) return periods.size === 1 ? [...periods][0] : null;
  if (/\b(?:yoy|year.over.year)\b/i.test(measure?.name ?? "")) return "year";
  if (/\b(?:qoq|quarter.over.quarter)\b/i.test(measure?.name ?? "")) return "quarter";
  if (/\b(?:mom|month.over.month)\b/i.test(measure?.name ?? "")) return "month";
  return null;
}

export function periodFilters(attribute: AttributeRef, period: Pick<CompleteKpiPeriod, "start" | "end">): QueryFilter[] {
  return [
    { attribute, op: "gte", value: period.start },
    { attribute, op: "lte", value: period.end },
  ];
}
