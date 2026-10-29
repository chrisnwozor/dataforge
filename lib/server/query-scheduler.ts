import { HttpError } from "./http";

export const QUERY_SCHEDULE_TIMEOUT_MS = 30_000;
export const QUERY_PRIORITIES = { main: 0, totals: 1, values: 2, dashboard: 2.5, prefetch: 3, report: 4, reportScheduled: 5, checks: 6 } as const;
export type QueryPriority = keyof typeof QUERY_PRIORITIES;

export class QueryScheduleTimeoutError extends HttpError {
  readonly code = "ETIMEOUT";
  constructor() {
    super(504, "The query timed out while waiting for or using the database. Reduce the selection and try again.");
    this.name = "QueryScheduleTimeoutError";
  }
}

export class QueryScheduleCancelledError extends HttpError {
  constructor(message = "The query was cancelled.") {
    super(499, message);
    this.name = "QueryScheduleCancelledError";
  }
}

/** SQL concurrency belongs to a host/port, independently of database or login. */
export function queryServerKey(server: string, port = 1433): string {
  return JSON.stringify([server.trim().toLowerCase().replace(/\.$/, ""), port]);
}

export interface QueryScheduleOptions {
  projectId: string;
  serverKey: string;
  priority: QueryPriority;
  signal?: AbortSignal;
  /** One deadline covers queue time and execution, rather than restarting on dequeue. */
  timeoutMs?: number;
  /** Capture before metadata work so a late lower-priority request cannot rejoin a newer main. */
  expectedRevision?: number;
  onStart?: (queuedMs: number, remainingMs: number) => void;
}

export type ScheduledQuery<T> = (signal: AbortSignal, remainingMs: number, queuedMs: number) => Promise<T>;

interface Job {
  projectId: string;
  serverKey: string;
  priority: number;
  sequence: number;
  enqueuedAt: number;
  deadline: number;
  controller: AbortController;
  state: "queued" | "running" | "finished";
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  callerSignal?: AbortSignal;
  callerAbort: () => void;
  onStart?: QueryScheduleOptions["onStart"];
  task: ScheduledQuery<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface SchedulerOptions {
  maxPerServer?: number;
  maxQueued?: number;
  maxQueuedPerProject?: number;
  now?: () => number;
}

/**
 * Process-local SQL admission control. Aborting a running job rejects its caller
 * immediately, but its project/server slots remain owned until driver cleanup
 * settles. Releasing on AbortSignal alone would allow overlapping SQL requests.
 */
export class QueryScheduler {
  private queue: Job[] = [];
  private active = new Set<Job>();
  private activeProjects = new Set<string>();
  private serverCounts = new Map<string, number>();
  private revisions = new Map<string, number>();
  private idle = new Set<() => void>();
  private sequence = 0;
  private draining = false;
  private closed = false;
  private readonly maxPerServer: number;
  private readonly maxQueued: number;
  private readonly maxQueuedPerProject: number;
  private readonly now: () => number;

  constructor(options: SchedulerOptions = {}) {
    this.maxPerServer = Math.max(1, Math.min(2, Math.floor(options.maxPerServer ?? 2)));
    this.maxQueued = Math.max(0, Math.floor(options.maxQueued ?? 128));
    this.maxQueuedPerProject = Math.max(0, Math.floor(options.maxQueuedPerProject ?? 32));
    this.now = options.now ?? (() => performance.now());
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active.size, queued: this.queue.length };
  }

  getRevision(projectId: string): number {
    return this.revisions.get(projectId) ?? 0;
  }

  /** Call before cache/metadata work as well: a cache hit can supersede a slicer. */
  beginMain(projectId: string): number {
    const revision = this.getRevision(projectId) + 1;
    this.revisions.set(projectId, revision);
    this.cancelLowerPriority(projectId);
    return revision;
  }

  cancelLowerPriority(projectId: string): number {
    const lower = [...this.queue, ...this.active].filter((job) => job.projectId === projectId && job.priority > QUERY_PRIORITIES.main && !job.settled);
    for (const job of lower)
      this.cancel(job, new QueryScheduleCancelledError("A newer main query replaced this lower-priority request."));
    return lower.length;
  }

  schedule<T>(options: QueryScheduleOptions, task: ScheduledQuery<T>): Promise<T> {
    if (this.closed) return Promise.reject(new HttpError(503, "The query scheduler is shutting down. Try again shortly."));
    if (options.signal?.aborted) return Promise.reject(new QueryScheduleCancelledError());
    const timeoutMs = options.timeoutMs ?? QUERY_SCHEDULE_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      return Promise.reject(new RangeError("Query timeout must be between 1 and 2,147,483,647 milliseconds."));
    if (!Object.hasOwn(QUERY_PRIORITIES, options.priority)) return Promise.reject(new RangeError("Unknown query priority."));
    if (options.expectedRevision !== undefined && options.expectedRevision !== this.getRevision(options.projectId))
      return Promise.reject(new QueryScheduleCancelledError("A newer main query replaced this request before it reached the database queue."));
    if (options.priority === "main") {
      if (options.expectedRevision === undefined) this.beginMain(options.projectId);
      else this.cancelLowerPriority(options.projectId);
    }
    const serverKey = options.serverKey.trim().toLowerCase();
    const canStart = !this.activeProjects.has(options.projectId) && (this.serverCounts.get(serverKey) ?? 0) < this.maxPerServer;
    if (!canStart && (this.queue.length >= this.maxQueued || this.queue.filter((job) => job.projectId === options.projectId).length >= this.maxQueuedPerProject))
      return Promise.reject(new HttpError(503, "The database query queue is full. Wait for an active query to finish and try again."));
    const enqueuedAt = this.now();
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        projectId: options.projectId,
        serverKey,
        priority: QUERY_PRIORITIES[options.priority],
        sequence: this.sequence++,
        enqueuedAt,
        deadline: enqueuedAt + timeoutMs,
        controller: new AbortController(),
        state: "queued",
        settled: false,
        callerSignal: options.signal,
        callerAbort: () => this.cancel(job, new QueryScheduleCancelledError()),
        onStart: options.onStart,
        task,
        resolve: (value) => resolve(value as T),
        reject,
      };
      job.timer = setTimeout(() => this.cancel(job, new QueryScheduleTimeoutError()), timeoutMs);
      options.signal?.addEventListener("abort", job.callerAbort, { once: true });
      this.queue.push(job);
      this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      if (options.signal?.aborted) this.cancel(job, new QueryScheduleCancelledError());
      else this.drain();
    });
  }

  private settle(job: Job, outcome: { error: unknown } | { value: unknown }): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.callerSignal?.removeEventListener("abort", job.callerAbort);
    if ("error" in outcome) job.reject(outcome.error);
    else job.resolve(outcome.value);
  }

  private cancel(job: Job, error: Error): void {
    if (job.settled) return;
    // Settle first so an immediate driver's abort rejection cannot replace a timeout.
    this.settle(job, { error });
    job.controller.abort(error);
    if (job.state === "queued") {
      this.queue = this.queue.filter((candidate) => candidate !== job);
      job.state = "finished";
      this.drain();
      this.notifyIdle();
    }
  }

  private drain(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      let index: number;
      while ((index = this.queue.findIndex((job) => !this.activeProjects.has(job.projectId) && (this.serverCounts.get(job.serverKey) ?? 0) < this.maxPerServer)) !== -1) {
        const [job] = this.queue.splice(index, 1);
        if (job.deadline <= this.now()) {
          this.cancel(job, new QueryScheduleTimeoutError());
          continue;
        }
        this.start(job);
      }
      this.preemptForMain();
    } finally {
      this.draining = false;
    }
  }

  private preemptForMain(): void {
    const demand = new Map<string, Set<string>>();
    for (const job of this.queue) {
      if (job.priority !== QUERY_PRIORITIES.main) continue;
      const owner = [...this.active].find((active) => active.projectId === job.projectId);
      // A project already cancelling is eligible as soon as that cleanup ends.
      // A healthy running main cannot be preempted, so do not reserve another slot for it.
      if (owner && !owner.settled) continue;
      let projects = demand.get(job.serverKey);
      if (!projects) demand.set(job.serverKey, projects = new Set());
      projects.add(job.projectId);
    }
    for (const [serverKey, projects] of demand) {
      const owners = [...this.active].filter((job) => job.serverKey === serverKey);
      const free = Math.max(0, this.maxPerServer - owners.length);
      const ending = owners.filter((job) => job.settled).length;
      let needed = Math.min(projects.size, this.maxPerServer) - free - ending;
      const candidates = owners.filter((job) => !job.settled && job.priority > QUERY_PRIORITIES.main)
        .sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
      for (const job of candidates) {
        if (needed-- <= 0) break;
        this.cancel(job, new QueryScheduleCancelledError("A main query needs the database; this lower-priority request was cancelled."));
      }
    }
  }

  private start(job: Job): void {
    job.state = "running";
    this.active.add(job);
    this.activeProjects.add(job.projectId);
    this.serverCounts.set(job.serverKey, (this.serverCounts.get(job.serverKey) ?? 0) + 1);
    void Promise.resolve().then(async () => {
      if (job.controller.signal.aborted) return;
      if (job.deadline <= this.now()) {
        this.cancel(job, new QueryScheduleTimeoutError());
        return;
      }
      const queuedMs = Math.max(0, this.now() - job.enqueuedAt);
      const remainingMs = Math.max(1, Math.floor(job.deadline - this.now()));
      job.onStart?.(queuedMs, remainingMs);
      const value = await job.task(job.controller.signal, remainingMs, queuedMs);
      this.settle(job, { value });
    }).catch((error: unknown) => this.settle(job, { error })).finally(() => {
      job.state = "finished";
      this.active.delete(job);
      this.activeProjects.delete(job.projectId);
      const count = (this.serverCounts.get(job.serverKey) ?? 1) - 1;
      if (count) this.serverCounts.set(job.serverKey, count);
      else this.serverCounts.delete(job.serverKey);
      this.drain();
      this.notifyIdle();
    });
  }

  private notifyIdle(): void {
    if (this.active.size || this.queue.length) return;
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }

  /** Reject callers now, but wait for active driver's cancellation cleanup. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue, ...this.active])
      this.cancel(job, new HttpError(503, "The query scheduler is shutting down. Try again shortly."));
    if (this.active.size || this.queue.length)
      await new Promise<void>((resolve) => this.idle.add(resolve));
  }

  /** Reopen a fully drained scheduler for isolated tests or an explicit restart. */
  reset(): void {
    if (this.active.size || this.queue.length) throw new Error("Wait for SQL cleanup before resetting the query scheduler.");
    this.closed = false;
    this.sequence = 0;
    this.activeProjects.clear();
    this.serverCounts.clear();
    this.revisions.clear();
  }
}

const globals = globalThis as typeof globalThis & { dataforgeQueryScheduler?: QueryScheduler };
export const queryScheduler = (globals.dataforgeQueryScheduler ??= new QueryScheduler());
