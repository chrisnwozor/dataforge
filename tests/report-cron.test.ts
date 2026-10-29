import { describe, expect, it } from "vitest";
import { friendlyCron, nextCronRun, parseCron, validateReportTimezone } from "@/lib/reports/cron";

describe("report cron expressions", () => {
  it("parses lists, ranges, steps and Sunday aliases", () => {
    const parsed = parseCron("  */15 9-17/2 1,15 * 0,7 ");
    expect(parsed.expression).toBe("*/15 9-17/2 1,15 * 0,7");
    expect(parsed.minute.values).toEqual([0, 15, 30, 45]);
    expect(parsed.hour.values).toEqual([9, 11, 13, 15, 17]);
    expect(parsed.dayOfWeek.values).toEqual([0]);
    expect(parseCron("5/20 * * * *").minute.values).toEqual([5, 25, 45]);
  });

  it.each(["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "*/999 * * * *", "9-2 * * * *", "MON * * * *", "1,,2 * * * *", "@daily", "1e2 * * * *", "-1 * * * *"])("rejects invalid expression %j", (value) => expect(() => parseCron(value)).toThrow());

  it("uses a strictly future occurrence, not the current minute", () => {
    expect(nextCronRun("0 9 * * *", "UTC", "2026-10-29T09:00:00Z").toISOString()).toBe("2026-10-30T09:00:00.000Z");
    expect(nextCronRun("*/15 * * * *", "UTC", "2026-10-29T09:02:23Z").toISOString()).toBe("2026-10-29T09:15:00.000Z");
  });

  it("interprets the selected timezone independently of host timezone", () => {
    expect(nextCronRun("30 9 * * *", "America/New_York", "2026-10-29T00:00:00Z").toISOString()).toBe("2026-10-29T13:30:00.000Z");
    expect(nextCronRun("0 9 * * *", "Asia/Kathmandu", "2026-10-29T00:00:00Z").toISOString()).toBe("2026-10-29T03:15:00.000Z");
    expect(nextCronRun("0 1 * * *", "Pacific/Kiritimati", "2026-10-29T12:00:00Z").toISOString()).toBe("2026-10-29T11:00:00.000Z".replace("29T11", "30T11"));
  });

  it("skips missing DST wall-clock times rather than moving a run", () => {
    expect(nextCronRun("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z").toISOString()).toBe("2026-03-09T06:30:00.000Z");
    expect(nextCronRun("15 2 * * *", "Australia/Lord_Howe", "2026-10-03T12:00:00Z").toISOString()).toBe("2026-10-04T15:15:00.000Z");
  });

  it("runs once during a repeated fall-back wall minute", () => {
    expect(nextCronRun("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextCronRun("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z").toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("uses cron's OR rule for restricted day-of-month and day-of-week", () => {
    expect(nextCronRun("0 12 1 * 1", "UTC", "2026-10-01T12:00:00Z").toISOString()).toBe("2026-10-05T12:00:00.000Z");
    expect(nextCronRun("0 12 1 * *", "UTC", "2026-10-01T12:00:00Z").toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  it("finds leap days and rejects impossible calendar combinations with bounded work", () => {
    expect(nextCronRun("0 0 29 2 *", "UTC", "2097-01-01T00:00:00Z").toISOString()).toBe("2104-02-29T00:00:00.000Z");
    expect(() => nextCronRun("0 0 30 2 *", "UTC", "2026-01-01T00:00:00Z")).toThrow(/eight years/);
  });

  it("validates timezone and friendly picker values", () => {
    expect(validateReportTimezone("America/New_York")).toBe("America/New_York");
    expect(() => validateReportTimezone("Definitely/Not_Real")).toThrow(/timezone/);
    expect(friendlyCron("daily", 9, 30)).toBe("30 9 * * *");
    expect(friendlyCron("weekly", 9, 30, 1)).toBe("30 9 * * 1");
    expect(friendlyCron("monthly", 9, 30, 15)).toBe("30 9 15 * *");
    expect(() => friendlyCron("daily", 24, 0)).toThrow();
  });
});
