import { afterEach, describe, expect, it, vi } from "vitest";
import { startReportScheduler, tickReportSchedules, stopReportScheduler, type ReportScheduleEvent, type ReportScheduleStore } from "@/lib/server/report-scheduler";
import type { ReportSchedule } from "@/lib/server/reports";

const scheduled = (patch: Partial<ReportSchedule> = {}): ReportSchedule => ({ id: "schedule-one", reportId: "report-one", projectId: "project-one", cron: "0 9 * * *", timezone: "America/New_York", params: { category: "Furniture" }, formats: ["pdf", "xlsx"], enabled: true, lastRunAt: null, nextRunAt: "2026-10-29T13:00:00.000Z", ...patch });
function memoryStore(initial: ReportSchedule[], running: string[] = []) {
  const schedules = structuredClone(initial);
  const store: ReportScheduleStore = {
    due: (now) => schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt !== null && schedule.nextRunAt <= now).map((schedule) => structuredClone(schedule)),
    active: (_project, report) => running.includes(report),
    advance: (id, expected, patch) => {
      const schedule = schedules.find((entry) => entry.id === id);
      if (!schedule || schedule.nextRunAt !== expected) return false;
      Object.assign(schedule, patch); return true;
    },
  };
  return { store, schedules, running };
}
afterEach(() => { stopReportScheduler(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("persistent-process report schedules", () => {
  it("creates only one process timer and skips the startup backlog before normal ticks", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T13:00:00Z"));
    const { store, schedules } = memoryStore([scheduled({ cron: "* * * * *" })]);
    const first = vi.fn(), replacement = vi.fn(), log = vi.fn();
    startReportScheduler(first, { store, log });
    const stop = startReportScheduler(replacement, { store, log });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(first).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
    expect(schedules[0].nextRunAt).toBe("2026-10-29T13:01:00.000Z");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(replacement).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled();
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("dispatches a due schedule once and advances its next run in the selected timezone", async () => {
    const { store, schedules } = memoryStore([scheduled()]);
    const run = vi.fn(), log = vi.fn();
    expect(await tickReportSchedules(new Date("2026-10-29T13:00:15Z"), run, { store, log })).toEqual({ started: 1, missed: 0, overlap: 0, invalid: 0, failed: 0 });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ params: { category: "Furniture" }, formats: ["pdf", "xlsx"] }));
    expect(schedules[0].nextRunAt).toBe("2026-10-30T13:00:00.000Z");
    expect(schedules[0].lastRunAt).toBe("2026-10-29T13:00:15.000Z");
    await tickReportSchedules(new Date("2026-10-29T13:00:30Z"), run, { store, log });
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips and logs missed occurrences without replaying a backlog", async () => {
    const { store, schedules } = memoryStore([scheduled({ nextRunAt: "2026-10-20T13:00:00.000Z" })]);
    const run = vi.fn(), events: ReportScheduleEvent[] = [];
    const result = await tickReportSchedules(new Date("2026-10-29T14:00:00Z"), run, { store, log: (event) => events.push(event) });
    expect(result.missed).toBe(1); expect(run).not.toHaveBeenCalled();
    expect(events).toEqual([{ event: "missed", scheduleId: "schedule-one", reportId: "report-one" }]);
    expect(schedules[0].lastRunAt).toBeNull();
    expect(schedules[0].nextRunAt).toBe("2026-10-30T13:00:00.000Z");
  });

  it("skips even recently due occurrences during startup", async () => {
    const { store } = memoryStore([scheduled()]); const run = vi.fn();
    expect((await tickReportSchedules(new Date("2026-10-29T13:00:01Z"), run, { store, skipAllDue: true, log: () => {} })).missed).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("never overlaps a running report and continues with another report", async () => {
    const { store, schedules } = memoryStore([scheduled(), scheduled({ id: "schedule-two", reportId: "report-two" })], ["report-one"]);
    const run = vi.fn();
    const result = await tickReportSchedules(new Date("2026-10-29T13:00:00Z"), run, { store, log: () => {} });
    expect(result.overlap).toBe(1); expect(result.started).toBe(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ reportId: "report-two" }));
    expect(schedules[0].lastRunAt).toBeNull();
  });

  it("starts only one of two due schedules belonging to the same report", async () => {
    const { store, running } = memoryStore([scheduled(), scheduled({ id: "schedule-two" })]);
    const run = vi.fn((schedule: ReportSchedule) => { running.push(schedule.reportId); });
    const result = await tickReportSchedules(new Date("2026-10-29T13:00:00Z"), run, { store, log: () => {} });
    expect(result.started).toBe(1); expect(result.overlap).toBe(1); expect(run).toHaveBeenCalledOnce();
  });

  it("claims before awaiting a runner so concurrent ticks cannot double-dispatch", async () => {
    const { store } = memoryStore([scheduled()]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(() => pending), now = new Date("2026-10-29T13:00:00Z");
    const first = tickReportSchedules(now, run, { store, log: () => {} });
    const second = await tickReportSchedules(now, run, { store, log: () => {} });
    expect(second.started).toBe(0); expect(run).toHaveBeenCalledOnce();
    release(); await first;
  });

  it("does not dispatch if an edit or another worker won the claim", async () => {
    const { store } = memoryStore([scheduled()]); store.advance = () => false;
    const run = vi.fn();
    await tickReportSchedules(new Date("2026-10-29T13:00:00Z"), run, { store, log: () => {} });
    expect(run).not.toHaveBeenCalled();
  });

  it("disables invalid saved schedules and continues after a runner failure", async () => {
    const { store, schedules } = memoryStore([scheduled({ cron: "bad" }), scheduled({ id: "schedule-two", reportId: "report-two" })]);
    const events: ReportScheduleEvent[] = [];
    const result = await tickReportSchedules(new Date("2026-10-29T13:00:00Z"), () => { throw new Error("private connection details"); }, { store, log: (entry) => events.push(entry) });
    expect(result.invalid).toBe(1); expect(result.failed).toBe(1);
    expect(schedules[0].enabled).toBe(false); expect(schedules[0].nextRunAt).toBeNull();
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("ignores disabled and future schedules even if a store erroneously returns them", async () => {
    const { store } = memoryStore([]);
    store.due = () => [scheduled({ enabled: false }), scheduled({ nextRunAt: "2026-11-01T14:00:00.000Z" })];
    const run = vi.fn();
    await tickReportSchedules(new Date("2026-10-29T13:00:00Z"), run, { store, log: () => {} });
    expect(run).not.toHaveBeenCalled();
  });
});
