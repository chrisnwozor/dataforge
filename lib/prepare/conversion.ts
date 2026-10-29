import type { Cell, PrepareType } from "./schema";

export class ConversionError extends Error {
  constructor(message: string) { super(message); this.name = "ConversionError"; }
}
const fail = (type: string): never => { throw new ConversionError(`The value is not a valid ${type}.`); };
const pad = (value: number, length = 2) => String(value).padStart(length, "0");
const monthDays = (year: number, month: number) => month === 2 ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
export function isoCalendarDate(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > monthDays(year, month)) return fail("date");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}
export function calendarDateParts(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return fail("ISO date (YYYY-MM-DD)");
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  isoCalendarDate(...parts); return parts;
}
function parseDate(text: string, pattern?: string): string {
  if (!pattern || /^(?:yyyy-MM-dd|YYYY-MM-DD)$/i.test(pattern)) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(text);
    if (match) return isoCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!pattern && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return parseDate(text, "MM/dd/yyyy");
    return fail("date; use YYYY-MM-DD or provide a date pattern");
  }
  if (pattern.length > 80) throw new ConversionError("Date patterns may contain at most 80 characters.");
  const tokens: string[] = [];
  let source = "^", offset = 0;
  const token = /yyyy|YYYY|yy|YY|MM|dd|DD|M|d|D/g;
  for (const match of pattern.matchAll(token)) {
    source += pattern.slice(offset, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const upper = match[0].toUpperCase(); tokens.push(upper);
    source += upper === "YYYY" ? "(\\d{4})" : upper === "YY" ? "(\\d{2})" : "(\\d{1,2})";
    offset = match.index! + match[0].length;
  }
  source += pattern.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  if (tokens.length !== 3 || !tokens.some((value) => value === "YYYY" || value === "YY") || !tokens.some((value) => value === "M" || value === "MM") || !tokens.some((value) => value === "D" || value === "DD")) throw new ConversionError("Use a date pattern containing one year, month, and day (for example dd/MM/yyyy).");
  const match = new RegExp(source).exec(text);
  if (!match) return fail(`date matching ${pattern}`);
  let year = 0, month = 0, day = 0;
  tokens.forEach((value, index) => { const number = Number(match[index + 1]); if (value === "YYYY") year = number; else if (value === "YY") year = number >= 70 ? 1900 + number : 2000 + number; else if (value.startsWith("M")) month = number; else day = number; });
  return isoCalendarDate(year, month, day);
}

/** Strict, finite conversions; empty cells remain NULL and locale ambiguity needs a hint. */
export function convertCell(value: Cell, type: PrepareType, pattern?: string): Cell {
  if (value === null || value === "" || typeof value === "string" && !value.trim()) return null;
  if (type === "text") return String(value);
  const text = typeof value === "string" ? value.trim() : String(value);
  if (type === "date") return parseDate(text, pattern);
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const folded = text.toLowerCase();
    if (["true", "yes", "y", "1"].includes(folded)) return true;
    if (["false", "no", "n", "0"].includes(folded)) return false;
    return fail("boolean (true/false, yes/no, or 1/0)");
  }
  if (typeof value === "boolean" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return fail(type);
  const number = Number(text);
  if (!Number.isFinite(number) || type === "integer" && !Number.isSafeInteger(number)) return fail(type === "integer" ? "safe integer" : "finite decimal");
  return number;
}

export function addCalendarDate(value: string, unit: "YEAR" | "QUARTER" | "MONTH" | "WEEK" | "DAY", amount: number): string {
  const [year, month, day] = calendarDateParts(value);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 3_652_058) return fail("date offset");
  if (unit === "YEAR" || unit === "MONTH" || unit === "QUARTER") {
    const offset = (year - 1) * 12 + month - 1 + amount * (unit === "YEAR" ? 12 : unit === "QUARTER" ? 3 : 1);
    const nextYear = Math.floor(offset / 12) + 1, nextMonth = (offset % 12 + 12) % 12 + 1;
    return isoCalendarDate(nextYear, nextMonth, Math.min(day, monthDays(nextYear, nextMonth)));
  }
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + amount * (unit === "WEEK" ? 7 : 1));
  return isoCalendarDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
