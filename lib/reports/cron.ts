/** A deliberately small, five-field cron implementation. Times are interpreted in an IANA zone. */
export interface CronField { values: readonly number[]; unrestricted: boolean }
export interface ParsedCron {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

function field(source: string, lower: number, upper: number, weekday: boolean): CronField {
  const selected = new Set<number>();
  for (const segment of source.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(segment);
    if (!match) throw new Error("Use five numeric cron fields with *, lists, ranges, or steps.");
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(step) || step < 1 || step > upper - lower + 1) throw new Error("The cron step is outside this field's range.");
    const all = match[1] === "*";
    const range = all ? [lower, upper] : match[1].split("-").map(Number);
    const start = range[0], end = range[1] ?? (match[2] ? upper : start);
    if (start < lower || end > upper || start > end || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error("A cron field is outside its allowed range.");
    for (let value = start; value <= end; value += step) selected.add(weekday && value === 7 ? 0 : value);
  }
  return { values: [...selected].sort((a, b) => a - b), unrestricted: source === "*" || source === "*/1" };
}

export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== "string" || expression.length > 200) throw new Error("Enter a five-field cron expression.");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron uses five fields: minute hour day-of-month month day-of-week.");
  const fields = parts.map((part, index) => field(part, limits[index][0], limits[index][1], index === 4));
  return { expression: parts.join(" "), minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4] };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
export function validateReportTimezone(timezone: string): string {
  if (typeof timezone !== "string" || timezone.length > 100) throw new Error("Choose a valid IANA timezone, such as America/New_York.");
  try {
    if (!formatters.has(timezone)) {
      const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      formatter.format(new Date(0));
      if (formatters.size > 100) formatters.delete(formatters.keys().next().value!);
      formatters.set(timezone, formatter);
    }
  } catch { throw new Error("Choose a valid IANA timezone, such as America/New_York."); }
  return timezone;
}

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number }
function wallTime(value: number, timezone: string): WallTime {
  const result: Record<string, number> = {};
  for (const part of formatters.get(timezone)!.formatToParts(new Date(value))) if (part.type !== "literal") result[part.type] = Number(part.value);
  return result as unknown as WallTime;
}
function wallEpoch(parts: WallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

/**
 * Find the next future occurrence without relying on the host timezone.
 * Missing spring-forward wall times are skipped. A repeated fall-back wall
 * minute runs once (its first occurrence), preventing duplicate exports.
 * DOM and DOW use normal cron OR semantics when both are restricted.
 */
export function nextCronRun(expression: string | ParsedCron, timezone: string, after: Date | string | number): Date {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  validateReportTimezone(timezone);
  const afterMs = typeof after === "number" ? after : new Date(after).getTime();
  if (!Number.isFinite(afterMs)) throw new Error("Provide a valid schedule starting time.");
  const current = wallTime(afterMs, timezone);
  const first = new Date(0);
  first.setUTCFullYear(current.year, current.month - 1, current.day);
  first.setUTCHours(0, 0, 0, 0);
  const maxDays = 366 * 8; // Includes a leap-day schedule across a non-leap century.
  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    const date = new Date(first.getTime() + dayOffset * 86_400_000);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (year > 9999 || !cron.month.values.includes(month)) continue;
    const dom = cron.dayOfMonth.values.includes(day), dow = cron.dayOfWeek.values.includes(date.getUTCDay());
    const dayMatches = cron.dayOfMonth.unrestricted ? dow : cron.dayOfWeek.unrestricted ? dom : dom || dow;
    if (!dayMatches) continue;
    // Date offsets on either side of a transition cover both possible UTC
    // offsets, including half-hour transitions and fractional-hour zones.
    const noon = date.getTime() + 12 * 3_600_000;
    const offsets = new Set<number>();
    for (const delta of [-36, 0, 36]) {
      const sample = noon + delta * 3_600_000;
      offsets.add(wallEpoch(wallTime(sample, timezone)) - sample);
    }
    let earliest = Infinity;
    const minimumOffset = Math.min(...offsets), maximumOffset = Math.max(...offsets);
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const target = date.getTime() + hour * 3_600_000 + minute * 60_000;
      // Most minutes can be rejected arithmetically. Intl conversions are only
      // needed near a viable future occurrence, keeping frequent schedules cheap.
      if (target - minimumOffset <= afterMs || target - maximumOffset >= earliest) continue;
      const candidates: number[] = [];
      for (const offset of offsets) {
        const candidate = target - offset;
        const wall = wallTime(candidate, timezone);
        if (wall.year === year && wall.month === month && wall.day === day && wall.hour === hour && wall.minute === minute) candidates.push(candidate);
      }
      // Intentionally do not take the second occurrence of a repeated minute.
      const candidate = Math.min(...candidates);
      if (candidate > afterMs && candidate < earliest) earliest = candidate;
    }
    if (earliest < Infinity) return new Date(earliest);
  }
  throw new Error("This cron expression has no occurrence in the next eight years.");
}

export function friendlyCron(kind: "daily" | "weekly" | "monthly", hour: number, minute: number, day = 1): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error("Choose a valid time of day.");
  const expression = kind === "daily" ? `${minute} ${hour} * * *` : kind === "weekly" ? `${minute} ${hour} * * ${day}` : `${minute} ${hour} ${day} * *`;
  parseCron(expression);
  return expression;
}
