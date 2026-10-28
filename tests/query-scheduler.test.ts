import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QueryScheduler,
  QueryScheduleCancelledError,
  QueryScheduleTimeoutError,
  queryServerKey,
  type QueryPriority,
} from "@/lib/server/query-scheduler";

const server = queryServerKey("sql.example.test", 1433);
const options = (projectId: string, priority: QueryPriority = "main") => ({ projectId, priority, serverKey: server });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
const observed = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error);
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("SQL admission by project and server", () => {
  it("normalizes server identity without login or database fields", () => {
    expect(queryServerKey(" SQL.Example.TEST. ")).toBe(queryServerKey("sql.example.test", 1433));
    expect(queryServerKey("sql.example.test", 1444)).not.toBe(server);
    expect(queryServerKey("::1", 1433)).not.toBe(queryServerKey("::", 11433));
  });

  it("runs one query per project and at most two per server", async () => {
    const scheduler = new QueryScheduler();
    const a = deferred(), aNext = deferred(), b = deferred(), c = deferred();
    const started: string[] = [];
    const run = (label: string, value: { promise: Promise<void> }) => async () => { started.push(label); await value.promise; return label; };
    const pa = scheduler.schedule(options("a"), run("a", a));
    const paNext = scheduler.schedule(options("a"), run("a-next", aNext));
    const pb = scheduler.schedule(options("b"), run("b", b));
    const pc = scheduler.schedule(options("c"), run("c", c));
    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 2 });
    a.resolve(); await flush();
    expect(started).toEqual(["a", "b", "a-next"]);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    aNext.resolve(); await flush();
    expect(started).toEqual(["a", "b", "a-next", "c"]);
    b.resolve(); c.resolve();
    expect(await Promise.all([pa, paNext, pb, pc])).toEqual(["a", "a-next", "b", "c"]);
    await flush(); expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("keeps project serialization across server changes and separates server caps", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    const first = scheduler.schedule(options("same-project"), async () => cleanup.promise);
    const called = vi.fn(async () => "new server");
    const next = scheduler.schedule({ ...options("same-project"), serverKey: queryServerKey("other.test") }, called);
    const other = deferred();
    const independent = scheduler.schedule({ ...options("independent"), serverKey: queryServerKey("other.test") }, async () => other.promise);
    await flush();
    expect(called).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    cleanup.resolve(); await first; await flush();
    expect(called).toHaveBeenCalledOnce();
    expect(await next).toBe("new server");
    other.resolve(); await independent; await flush();
  });

  it("starts main queries before totals, values, and prefetch, with FIFO ties", async () => {
    const scheduler = new QueryScheduler({ maxPerServer: 1 });
    const blocker = deferred();
    const first = scheduler.schedule(options("blocking"), async () => blocker.promise);
    const started: string[] = [];
    const jobs = [
      scheduler.schedule(options("prefetch", "prefetch"), async () => { started.push("prefetch"); }),
      scheduler.schedule(options("values-one", "values"), async () => { started.push("values-one"); }),
      scheduler.schedule(options("values-two", "values"), async () => { started.push("values-two"); }),
      scheduler.schedule(options("totals", "totals"), async () => { started.push("totals"); }),
      scheduler.schedule(options("main-one"), async () => { started.push("main-one"); }),
      scheduler.schedule(options("main-two"), async () => { started.push("main-two"); }),
    ];
    blocker.resolve(); await first; await Promise.all(jobs); await flush();
    expect(started).toEqual(["main-one", "main-two", "totals", "values-one", "values-two", "prefetch"]);
  });

  it("does not let a blocked project at the head stall another eligible project", async () => {
    const scheduler = new QueryScheduler();
    const a = deferred(), b = deferred();
    const aFirst = scheduler.schedule(options("a"), async () => a.promise);
    const aNextCalled = vi.fn(async () => "a next");
    const aNext = scheduler.schedule(options("a"), aNextCalled);
    const bFirst = scheduler.schedule(options("b"), async () => b.promise);
    const cCalled = vi.fn(async () => "c");
    const c = scheduler.schedule(options("c"), cCalled);
    await flush(); b.resolve(); await bFirst; await flush();
    expect(cCalled).toHaveBeenCalledOnce(); expect(aNextCalled).not.toHaveBeenCalled();
    a.resolve(); await Promise.all([aFirst, aNext, c]); await flush();
  });

  it("cancels lower-priority work for a new main but holds slots through cancellation cleanup", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred(), unrelatedCleanup = deferred();
    let signal: AbortSignal | undefined;
    const value = observed(scheduler.schedule(options("a", "values"), async (valueSignal) => { signal = valueSignal; await cleanup.promise; return "stale"; }));
    const prefetchTask = vi.fn(async () => "not run");
    const prefetch = observed(scheduler.schedule(options("a", "prefetch"), prefetchTask));
    let unrelatedSignal: AbortSignal | undefined;
    const unrelated = scheduler.schedule(options("b", "values"), async (valueSignal) => { unrelatedSignal = valueSignal; await unrelatedCleanup.promise; });
    await flush();
    const mainTask = vi.fn(async () => "main");
    const main = scheduler.schedule(options("a"), mainTask);
    expect(await value).toBeInstanceOf(QueryScheduleCancelledError);
    expect(await prefetch).toBeInstanceOf(QueryScheduleCancelledError);
    expect(signal?.aborted).toBe(true);
    expect(unrelatedSignal?.aborted).toBe(false);
    expect(prefetchTask).not.toHaveBeenCalled();
    await flush(); expect(mainTask).not.toHaveBeenCalled();
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    cleanup.resolve(); await flush(); expect(await main).toBe("main");
    expect(mainTask).toHaveBeenCalledOnce();
    unrelatedCleanup.resolve(); await unrelated; await flush();
  });

  it("supersedes lower-priority work even when the new main is served from cache", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    let signal: AbortSignal | undefined;
    const value = observed(scheduler.schedule(options("a", "values"), async (valueSignal) => { signal = valueSignal; await cleanup.promise; }));
    await flush();
    expect(scheduler.beginMain("a")).toBe(1);
    expect(await value).toMatchObject({ status: 499 }); expect(signal?.aborted).toBe(true);
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    cleanup.resolve(); await flush();
  });

  it("preempts only one lower-priority owner on a full server for a different project's main", async () => {
    const scheduler = new QueryScheduler();
    const aCleanup = deferred(), bCleanup = deferred(), mainCleanup = deferred();
    let aSignal: AbortSignal | undefined, bSignal: AbortSignal | undefined;
    const a = observed(scheduler.schedule(options("a", "values"), async (signal) => { aSignal = signal; await aCleanup.promise; }));
    const b = observed(scheduler.schedule(options("b", "prefetch"), async (signal) => { bSignal = signal; await bCleanup.promise; }));
    await flush();
    const called = vi.fn(async () => mainCleanup.promise);
    const main = scheduler.schedule(options("c"), called);
    expect(await b).toMatchObject({ status: 499 });
    expect(bSignal?.aborted).toBe(true); expect(aSignal?.aborted).toBe(false);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    await flush(); expect(called).not.toHaveBeenCalled();
    bCleanup.resolve(); await flush();
    expect(called).toHaveBeenCalledOnce();
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 0 });
    expect(aSignal?.aborted).toBe(false);
    mainCleanup.resolve(); aCleanup.resolve(); await Promise.all([main, a]); await flush();
  });

  it("keeps FIFO main admission across repeated server preemptions", async () => {
    const scheduler = new QueryScheduler();
    const aCleanup = deferred(), bCleanup = deferred();
    let aSignal: AbortSignal | undefined, bSignal: AbortSignal | undefined;
    const a = observed(scheduler.schedule(options("a", "values"), async (signal) => { aSignal = signal; await aCleanup.promise; }));
    const b = observed(scheduler.schedule(options("b", "values"), async (signal) => { bSignal = signal; await bCleanup.promise; }));
    await flush();
    const started: string[] = [];
    const c = scheduler.schedule(options("c"), async () => { started.push("c"); });
    const d = scheduler.schedule(options("d"), async () => { started.push("d"); });
    expect(await a).toMatchObject({ status: 499 }); expect(await b).toMatchObject({ status: 499 });
    expect(aSignal?.aborted).toBe(true); expect(bSignal?.aborted).toBe(true);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 2 });
    aCleanup.resolve(); await flush();
    expect(started).toEqual(["c", "d"]);
    bCleanup.resolve(); await Promise.all([c, d]); await flush();
  });

  it("does not preempt unrelated slicers when a main has a free slot or is project-blocked", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred(), mainCleanup = deferred();
    let signal: AbortSignal | undefined;
    const value = scheduler.schedule(options("a", "values"), async (valueSignal) => { signal = valueSignal; await cleanup.promise; });
    const main = scheduler.schedule(options("b"), async () => mainCleanup.promise);
    const next = scheduler.schedule(options("b"), async () => "next b");
    await flush();
    expect(signal?.aborted).toBe(false);
    expect(scheduler.snapshot()).toEqual({ active: 2, queued: 1 });
    mainCleanup.resolve(); await main; await flush(); expect(await next).toBe("next b");
    expect(signal?.aborted).toBe(false);
    cleanup.resolve(); await value; await flush();
  });

  it("rejects requests whose metadata finished after a newer main revision", async () => {
    const scheduler = new QueryScheduler();
    const previous = scheduler.getRevision("a");
    const current = scheduler.beginMain("a");
    const called = vi.fn(async () => "not reached");
    expect(await observed(scheduler.schedule({ ...options("a", "values"), expectedRevision: previous }, called))).toMatchObject({ status: 499 });
    expect(called).not.toHaveBeenCalled();
    expect(await scheduler.schedule({ ...options("a"), expectedRevision: current }, async () => "main")).toBe("main");
    expect(scheduler.getRevision("a")).toBe(current);
    await flush();
    scheduler.beginMain("a");
    expect(await observed(scheduler.schedule({ ...options("a"), expectedRevision: current }, called))).toMatchObject({ status: 499 });
    expect(called).not.toHaveBeenCalled();
  });

  it("removes aborted queued work without invoking it", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    const first = scheduler.schedule(options("a"), async () => cleanup.promise);
    const controller = new AbortController();
    const called = vi.fn(async () => "not run");
    const queued = observed(scheduler.schedule({ ...options("a"), signal: controller.signal }, called));
    controller.abort();
    expect(await queued).toMatchObject({ status: 499 });
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    cleanup.resolve(); await first; await flush();
    expect(called).not.toHaveBeenCalled();
  });

  it("does not let a pre-aborted main cancel an active slicer", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    let signal: AbortSignal | undefined;
    const value = scheduler.schedule(options("a", "values"), async (valueSignal) => { signal = valueSignal; await cleanup.promise; });
    await flush();
    const controller = new AbortController(); controller.abort();
    expect(await observed(scheduler.schedule({ ...options("a"), signal: controller.signal }, async () => "not run"))).toMatchObject({ status: 499 });
    expect(signal?.aborted).toBe(false); expect(scheduler.getRevision("a")).toBe(0);
    cleanup.resolve(); await value; await flush();
  });

  it("expires queued work at its own deadline without waiting for a connection", async () => {
    const scheduler = new QueryScheduler({ maxPerServer: 1 });
    const cleanup = deferred();
    const first = scheduler.schedule(options("a"), async () => cleanup.promise);
    const called = vi.fn(async () => "not reached");
    const queued = observed(scheduler.schedule({ ...options("b"), timeoutMs: 100 }, called));
    await vi.advanceTimersByTimeAsync(100);
    expect(await queued).toBeInstanceOf(QueryScheduleTimeoutError);
    expect(await queued).toMatchObject({ status: 504, code: "ETIMEOUT" });
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    cleanup.resolve(); await first; await flush();
    expect(called).not.toHaveBeenCalled();
  });

  it("deducts queue time from the execution budget and aborts at the original deadline", async () => {
    const scheduler = new QueryScheduler({ maxPerServer: 1 });
    const blocker = deferred(), cleanup = deferred();
    const first = scheduler.schedule(options("a"), async () => blocker.promise);
    const start = vi.fn();
    let signal: AbortSignal | undefined;
    const task = vi.fn(async (valueSignal: AbortSignal) => { signal = valueSignal; await cleanup.promise; });
    const queued = observed(scheduler.schedule({ ...options("b"), timeoutMs: 1000, onStart: start }, task));
    await vi.advanceTimersByTimeAsync(400);
    blocker.resolve(); await first; await flush();
    expect(start).toHaveBeenCalledWith(400, 600);
    expect(task).toHaveBeenCalledWith(expect.any(AbortSignal), 600, 400);
    await vi.advanceTimersByTimeAsync(599); expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await queued).toMatchObject({ status: 504 }); expect(signal?.aborted).toBe(true);
    expect(scheduler.snapshot()).toEqual({ active: 1, queued: 0 });
    cleanup.resolve(); await flush(); expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("holds a timed-out running query's project slot until its driver settles", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    const running = observed(scheduler.schedule({ ...options("a"), timeoutMs: 50 }, async () => cleanup.promise));
    await vi.advanceTimersByTimeAsync(50);
    expect(await running).toMatchObject({ status: 504 });
    const called = vi.fn(async () => "next");
    const next = scheduler.schedule(options("a"), called);
    await flush(); expect(called).not.toHaveBeenCalled();
    cleanup.resolve(); await flush(); expect(await next).toBe("next");
    await flush(); expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("cleans slots and listeners after task or timing-observer failure", async () => {
    const scheduler = new QueryScheduler();
    const expected = new Error("driver failed");
    expect(await observed(scheduler.schedule(options("a"), async () => { throw expected; }))).toBe(expected);
    await flush();
    const called = vi.fn(async () => "not called");
    const observerError = new Error("observer failed");
    expect(await observed(scheduler.schedule({ ...options("a"), onStart: () => { throw observerError; } }, called))).toBe(observerError);
    expect(called).not.toHaveBeenCalled(); await flush();
    expect(await scheduler.schedule(options("a"), async () => "healthy")).toBe("healthy");
    await flush(); expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("preserves rejected undefined values rather than resolving them", async () => {
    const scheduler = new QueryScheduler();
    await expect(scheduler.schedule(options("a"), () => Promise.reject(undefined))).rejects.toBeUndefined();
    await flush();
  });

  it("bounds the queue and rejects invalid deadlines before changing priorities", async () => {
    const scheduler = new QueryScheduler({ maxQueued: 1, maxQueuedPerProject: 1 });
    const cleanup = deferred();
    const first = scheduler.schedule(options("a"), async () => cleanup.promise);
    const second = scheduler.schedule(options("a"), async () => "queued");
    expect(await observed(scheduler.schedule(options("a"), async () => "overflow"))).toMatchObject({ status: 503 });
    expect(await observed(scheduler.schedule({ ...options("b"), timeoutMs: 0 }, async () => "bad timeout"))).toBeInstanceOf(RangeError);
    cleanup.resolve(); await Promise.all([first, second]); await flush();
  });

  it("shuts down callers, waits for SQL cancellation cleanup, and can reopen after drain", async () => {
    const scheduler = new QueryScheduler();
    const cleanup = deferred();
    let signal: AbortSignal | undefined;
    const first = observed(scheduler.schedule(options("a"), async (valueSignal) => { signal = valueSignal; await cleanup.promise; }));
    const called = vi.fn(async () => "not reached");
    const second = observed(scheduler.schedule(options("a"), called));
    await flush();
    let closed = false;
    const closing = scheduler.close().then(() => { closed = true; });
    expect(await first).toMatchObject({ status: 503 }); expect(await second).toMatchObject({ status: 503 });
    expect(signal?.aborted).toBe(true); expect(called).not.toHaveBeenCalled(); expect(closed).toBe(false);
    expect(() => scheduler.reset()).toThrow(/cleanup/);
    expect(await observed(scheduler.schedule(options("b"), async () => "closed"))).toMatchObject({ status: 503 });
    cleanup.resolve(); await closing; expect(closed).toBe(true);
    scheduler.reset(); expect(scheduler.getRevision("a")).toBe(0);
    expect(await scheduler.schedule(options("a"), async () => "reopened")).toBe("reopened");
    await flush(); expect(scheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });
});
