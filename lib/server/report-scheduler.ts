import { localMode } from "@/lib/auth/context";
import { runScheduledContext } from "@/lib/auth/scheduled";
import { nextCronRun } from "@/lib/reports/cron";
import { advanceReportSchedule, getActiveReportRun, listDueReportSchedules, type ReportSchedule } from "./reports";

export type ScheduledReportRunner = (schedule: ReportSchedule) => unknown | Promise<unknown>;
export interface ReportScheduleStore {
  due: (now: string) => ReportSchedule[];
  active: (projectId: string, reportId: string) => unknown;
  advance: (scheduleId: string, expected: string | null, patch: { nextRunAt: string | null; lastRunAt?: string | null; enabled?: boolean }) => boolean;
}
export type ReportScheduleEvent = { event: "started" | "missed" | "overlap" | "invalid" | "failed"; scheduleId: string; reportId: string };
export interface ReportScheduleTickOptions {
  store?: ReportScheduleStore;
  log?: (entry: ReportScheduleEvent) => void;
  /** Startup skips every overdue occurrence instead of replaying missed exports. */
  skipAllDue?: boolean;
  graceMs?: number;
}
const defaultStore: ReportScheduleStore = { due: listDueReportSchedules, active: getActiveReportRun, advance: advanceReportSchedule };
const defaultLog = (entry: ReportScheduleEvent) => console.info("[DataForge report schedule]", JSON.stringify(entry));

/** One atomic next_run_at claim prevents overlapping ticks from dispatching a schedule twice. */
export async function tickReportSchedules(now: Date, run: ScheduledReportRunner, options: ReportScheduleTickOptions = {}): Promise<{ started: number; missed: number; overlap: number; invalid: number; failed: number }> {
  const store = options.store ?? defaultStore, log = options.log ?? defaultLog;
  const result = { started: 0, missed: 0, overlap: 0, invalid: 0, failed: 0 };
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Provide a valid report scheduler time.");
  for (const schedule of store.due(now.toISOString())) {
    if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > nowMs) continue;
    let next: string;
    try { next = nextCronRun(schedule.cron, schedule.timezone, now).toISOString(); }
    catch {
      if (store.advance(schedule.id, schedule.nextRunAt, { enabled: false, nextRunAt: null })) {
        result.invalid++; log({ event: "invalid", scheduleId: schedule.id, reportId: schedule.reportId });
      }
      continue;
    }
    const missed = options.skipAllDue || nowMs - Date.parse(schedule.nextRunAt) > (options.graceMs ?? 60_000);
    if (missed) {
      if (store.advance(schedule.id, schedule.nextRunAt, { nextRunAt: next })) {
        result.missed++; log({ event: "missed", scheduleId: schedule.id, reportId: schedule.reportId });
      }
      continue;
    }
    let isActive: unknown;
    try { isActive = options.store || localMode() ? store.active(schedule.projectId, schedule.reportId) : runScheduledContext(schedule.id, schedule.projectId, () => store.active(schedule.projectId, schedule.reportId)); }
    catch {
      store.advance(schedule.id, schedule.nextRunAt, { enabled: false, nextRunAt: null });
      result.invalid++; log({event: "invalid", scheduleId: schedule.id, reportId: schedule.reportId}); continue;
    }
    if (isActive) {
      if (store.advance(schedule.id, schedule.nextRunAt, { nextRunAt: next })) {
        result.overlap++; log({ event: "overlap", scheduleId: schedule.id, reportId: schedule.reportId });
      }
      continue;
    }
    if (!store.advance(schedule.id, schedule.nextRunAt, { nextRunAt: next, lastRunAt: now.toISOString() })) continue;
    try {
      await (options.store || localMode() ? run(schedule) : runScheduledContext(schedule.id, schedule.projectId, () => run(schedule)));
      result.started++; log({ event: "started", scheduleId: schedule.id, reportId: schedule.reportId });
    } catch {
      // The runner records its own failure; the scheduler logs only identities,
      // never parameters, SQL, connection strings, or credentials.
      result.failed++; log({ event: "failed", scheduleId: schedule.id, reportId: schedule.reportId });
    }
  }
  return result;
}

interface SchedulerState { timer?: ReturnType<typeof setInterval>; busy: boolean; stopped: boolean; run: ScheduledReportRunner }
const schedulerGlobal = globalThis as typeof globalThis & { dataforgeReportScheduler?: SchedulerState };

/** Requires one persistent Node process; no external worker or native module. */
export function startReportScheduler(run: ScheduledReportRunner, options: Pick<ReportScheduleTickOptions, "store" | "log"> = {}): () => void {
  const existing = schedulerGlobal.dataforgeReportScheduler;
  if (existing && !existing.stopped) { existing.run = run; return () => stopReportScheduler(); }
  const state: SchedulerState = { busy: true, stopped: false, run };
  schedulerGlobal.dataforgeReportScheduler = state;
  const tick = async (startup = false) => {
    if (state.stopped) return;
    state.busy = true;
    try { await tickReportSchedules(new Date(), state.run, { ...options, skipAllDue: startup }); }
    catch { console.warn("[DataForge report schedule] Scheduler tick failed; it will retry on the next interval."); }
    finally { state.busy = false; }
  };
  // A stopped application never catches up a backlog of scheduled exports.
  void tick(true);
  state.timer = setInterval(() => { if (!state.busy) void tick(); }, 30_000);
  state.timer.unref?.();
  return () => stopReportScheduler();
}

export function stopReportScheduler(): void {
  const state = schedulerGlobal.dataforgeReportScheduler;
  if (!state) return;
  state.stopped = true;
  clearInterval(state.timer);
  delete schedulerGlobal.dataforgeReportScheduler;
}
