import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery, QueryTimings } from "@/lib/semantic/query/types";
import {
  executeCompiledQuery,
  closeQueryPools,
  QueryAbortedError,
  QueryTimeoutError,
  QUERY_REQUEST_TIMEOUT_MS,
  QUERY_CANCEL_GRACE_MS,
} from "@/lib/server/query-transport";

interface RequestControl {
  resolve(): void;
  reject(error: Error): void;
}
const state = vi.hoisted(() => ({
  events: [] as string[],
  inputs: [] as { name: string; type: unknown; value: unknown }[],
  configs: [] as unknown[],
  timeout: 0,
  nextSession: 0,
  failConnect: false,
  waitConnect: false,
  resumeConnect: undefined as (() => void) | undefined,
  waitAcquire: false,
  resumeAcquire: undefined as (() => void) | undefined,
  wait: false,
  cancelAck: true,
  driverTimeout: false,
  failQuery: undefined as Error | undefined,
  queryStarted: undefined as (() => void) | undefined,
  connectStarted: undefined as (() => void) | undefined,
  acquireStarted: undefined as (() => void) | undefined,
  controls: [] as RequestControl[],
  rowDelays: false,
  dialDelay: 0,
  sqlTexts: [] as string[],
  batches: [] as string[],
  infoMessages: [] as string[],
  statisticsFailure: undefined as "ON" | "OFF" | undefined,
}));
vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  class Physical {
    id = ++state.nextSession;
    closed = false;
    hasError = false;
    reject?: (error: Error) => void;
    socket = {
      destroy: () => {
        state.events.push("socketDestroy");
        this.closed = true;
      },
    };
    close() {
      if (!this.closed) state.events.push("destroy");
      this.closed = true;
      this.reject?.(new Error("connection closed"));
    }
  }
  class ConnectionPool extends EventEmitter {
    collation = {};
    free: Physical[] = [];
    used = new Set<Physical>();
    constructor(public config: Record<string, unknown>) {
      super();
      state.configs.push(config);
      state.events.push("pool:create");
    }
    async _poolCreate() {
      if (state.dialDelay) await delay(state.dialDelay);
      return new Physical();
    }
    async connect() {
      state.events.push("connect");
      state.connectStarted?.();
      if (state.failConnect) throw new Error("connection refused");
      if (state.waitConnect)
        await new Promise<void>((resolve) => {
          state.resumeConnect = resolve;
        });
      // mssql makes a separate login probe; real checkout is a lazy connection.
      const probe = await this._poolCreate();
      probe.close();
      return this;
    }
    async acquire() {
      state.events.push("reserve");
      state.acquireStarted?.();
      if (state.waitAcquire)
        await new Promise<void>((resolve) => {
          state.resumeAcquire = resolve;
        });
      let connection: Physical | undefined;
      while ((connection = this.free.shift()))
        if (!connection.closed && !connection.hasError) break;
      if (!connection || connection.closed || connection.hasError)
        connection = await this._poolCreate();
      this.used.add(connection);
      return connection;
    }
    release(connection: Physical) {
      expect(this.used.has(connection)).toBe(true);
      state.events.push(
        connection.closed || connection.hasError ? "discard" : "release",
      );
      this.used.delete(connection);
      if (!connection.closed && !connection.hasError)
        this.free.push(connection);
    }
    async close() {
      state.events.push("pool:close");
      for (const connection of this.free) connection.close();
      this.free = [];
    }
  }
  interface Parent {
    acquire(
      request: unknown,
      callback: (error: Error | null, connection: Physical) => void,
    ): void;
    release(connection: Physical): void;
  }
  class Request extends EventEmitter {
    stream = false;
    reject?: (error: Error) => void;
    constructor(
      public parent: Parent,
      options: { requestTimeout: number },
    ) {
      super();
      state.timeout = options.requestTimeout;
    }
    input(name: string, type: unknown, value: unknown) {
      state.inputs.push({ name, type, value });
      return this;
    }
    async query(sql: string) {
      state.sqlTexts.push(sql);
      expect(sql).toMatch(/^(SELECT|SET STATISTICS TIME (?:ON|OFF);)/);
      const connection = await new Promise<Physical>((resolve, reject) =>
        this.parent.acquire(this, (error, physical) =>
          error ? reject(error) : resolve(physical),
        ),
      );
      const setting = sql.match(/^SET STATISTICS TIME (ON|OFF);$/)?.[1];
      if (setting) {
        state.events.push(`statistics:${setting.toLowerCase()}`);
        if (state.statisticsFailure === setting)
          throw new Error("Statistics setting failed");
        return { recordset: undefined };
      }
      state.events.push("select");
      if (state.driverTimeout) {
        const error = Object.assign(new Error("Driver timeout"), {
          code: "ETIMEOUT",
        });
        this.emit("error", error);
      } else if (state.failQuery) this.emit("error", state.failQuery);
      if (state.wait) {
        await new Promise<void>((resolve, reject) => {
          this.reject = reject;
          connection.reject = reject;
          state.controls.push({ resolve, reject });
          state.queryStarted?.();
        });
      } else state.queryStarted?.();
      if (state.rowDelays) {
        await delay(10);
        this.emit("row", { total: 4 });
        await delay(20);
        this.emit("row", { total: 5 });
        await delay(10);
      } else this.emit("row", { total: 9 });
      for (const message of state.infoMessages) this.emit("info", { message });
      state.events.push("done");
      this.parent.release(connection);
      connection.reject = undefined;
      return { recordset: undefined };
    }
    async batch(sql: string) {
      state.batches.push(sql);
      return this.query(sql);
    }
    cancel() {
      state.events.push("cancel");
      if (state.cancelAck)
        this.reject?.(
          Object.assign(new Error("cancel acknowledged"), { code: "ECANCEL" }),
        );
    }
  }
  return {
    default: {
      ConnectionPool,
      Request,
      Int: "Int",
      BigInt: "BigInt",
      Float: "Float",
      Bit: "Bit",
      DateTime2: "DateTime2",
      MAX: -1,
      NVarChar: (length: number) => `NVarChar(${length})`,
    },
  };
});
const settings = {
  server: "localhost",
  port: 1433,
  database: "DataForge",
  user: "reader",
  password: "test-only",
  encrypt: true,
  trustServerCertificate: true,
  stagingFolder: "/tmp",
};
const compiled: CompiledQuery = {
  sql: "SELECT TOP (@__df_limit) SUM([Sales]) AS [total] FROM [dw].[fact_sales]",
  params: [
    { name: "__df_limit", value: 1001, type: "number" },
    { name: "p1", value: "x'; DROP TABLE y;--", type: "string" },
    { name: "p2", value: true, type: "boolean" },
    { name: "p3", value: 1.5, type: "number" },
    { name: "p4", value: "2024-01-01", type: "date" },
  ],
  columns: [{ key: "total", name: "Sales", role: "measure", type: "number" }],
  limit: 1000,
};
beforeEach(async () => {
  await closeQueryPools();
  Object.assign(state, {
    events: [],
    inputs: [],
    configs: [],
    timeout: 0,
    nextSession: 0,
    failConnect: false,
    waitConnect: false,
    resumeConnect: undefined,
    waitAcquire: false,
    resumeAcquire: undefined,
    wait: false,
    cancelAck: true,
    driverTimeout: false,
    failQuery: undefined,
    queryStarted: undefined,
    connectStarted: undefined,
    acquireStarted: undefined,
    controls: [],
    rowDelays: false,
    dialDelay: 0,
    sqlTexts: [],
    batches: [],
    infoMessages: [],
    statisticsFailure: undefined,
  });
});
afterEach(async () => {
  await closeQueryPools();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function started(
  kind: "queryStarted" | "connectStarted" | "acquireStarted" = "queryStarted",
) {
  return new Promise<void>((resolve) => {
    state[kind] = resolve;
  });
}
const count = (event: string) =>
  state.events.filter((value) => value === event).length;

describe("pooled read-only semantic SQL transport", () => {
  it("enables SQL timings before the parameterized main RPC and resets them after its final info messages", async () => {
    state.infoMessages = [
      "SQL Server parse and compile time:\r\n CPU time = 31 ms, elapsed time = 978 ms.",
      "SQL Server Execution Times:\n CPU time = 2 ms, elapsed time = 39 ms.",
    ];
    const observe = vi.fn();
    expect(
      await executeCompiledQuery(
        settings,
        { ...compiled, diagnostics: true },
        undefined,
        observe,
      ),
    ).toEqual([{ total: 9 }]);
    expect(state.sqlTexts).toEqual([
      "SET STATISTICS TIME ON;",
      compiled.sql,
      "SET STATISTICS TIME OFF;",
    ]);
    expect(state.batches).toEqual([
      "SET STATISTICS TIME ON;",
      "SET STATISTICS TIME OFF;",
    ]);
    expect(observe.mock.calls[0][0]).toMatchObject({
      sqlCompileMs: 978,
      sqlCompileCpuMs: 31,
      sqlExecuteMs: 39,
      sqlExecuteCpuMs: 2,
    });
    expect(count("release")).toBe(1);
    expect(count("discard")).toBe(0);
    await executeCompiledQuery(settings, compiled);
    expect(count("connect")).toBe(1);
    expect(state.sqlTexts.at(-1)).toBe(compiled.sql);
  });
  it("does not enable diagnostics or invent zero SQL timing values for ordinary queries", async () => {
    const observe = vi.fn();
    await executeCompiledQuery(settings, compiled, undefined, observe);
    expect(state.sqlTexts).toEqual([compiled.sql]);
    expect(observe.mock.calls[0][0]).not.toHaveProperty("sqlCompileMs");
    expect(observe.mock.calls[0][0]).not.toHaveProperty("sqlExecuteMs");
  });
  it("resets STATISTICS TIME on SQL failure and physically discards a session whose reset fails", async () => {
    state.failQuery = new Error("Invalid generated table");
    await expect(
      executeCompiledQuery(settings, { ...compiled, diagnostics: true }),
    ).rejects.toThrow("Invalid generated table");
    expect(state.sqlTexts.at(-1)).toBe("SET STATISTICS TIME OFF;");
    expect(count("release")).toBe(1);
    state.failQuery = undefined;
    state.statisticsFailure = "OFF";
    await executeCompiledQuery(settings, { ...compiled, diagnostics: true });
    expect(count("discard")).toBe(1);
    expect(count("socketDestroy")).toBe(1);
  });
  it("discards cancelled materialized batches even after acknowledgement so temp objects cannot leak to a borrower", async () => {
    const controller = new AbortController();
    state.wait = true;
    const ready = started();
    const operation = executeCompiledQuery(
      settings,
      { ...compiled, materialized: true },
      controller.signal,
    );
    const rejected =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    controller.abort();
    await rejected;
    expect(count("cancel")).toBe(1);
    expect(count("discard")).toBe(1);
    expect(count("release")).toBe(0);
    expect(count("socketDestroy")).toBe(1);
  });
  it("discards a diagnostics session on cancellation instead of leaving STATISTICS TIME enabled", async () => {
    const controller = new AbortController();
    state.wait = true;
    const ready = started();
    const operation = executeCompiledQuery(
      settings,
      { ...compiled, diagnostics: true },
      controller.signal,
    );
    const rejected =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    controller.abort();
    await rejected;
    expect(state.sqlTexts).toEqual(["SET STATISTICS TIME ON;", compiled.sql]);
    expect(count("discard")).toBe(1);
  });
  it("reuses one healthy pool/session and binds limit as SQL Int rather than BigInt", async () => {
    expect(await executeCompiledQuery(settings, compiled)).toEqual([
      { total: 9 },
    ]);
    expect(await executeCompiledQuery(settings, compiled)).toEqual([
      { total: 9 },
    ]);
    expect(count("pool:create")).toBe(1);
    expect(count("connect")).toBe(1);
    expect(count("select")).toBe(2);
    expect(count("release")).toBe(2);
    expect(count("pool:close")).toBe(0);
    expect(state.timeout).toBe(30_000);
    expect(state.inputs[0]).toEqual({
      name: "__df_limit",
      type: "Int",
      value: 1001,
    });
    expect(state.inputs[1]).toEqual({
      name: "p1",
      type: "NVarChar(-1)",
      value: "x'; DROP TABLE y;--",
    });
    expect(state.inputs[4].value).toEqual(new Date("2024-01-01"));
    expect(state.configs[0]).toMatchObject({
      validateConnection: "socket",
      pool: { max: 4, min: 0 },
      options: { cancelTimeout: 5000 },
    });
  });
  it("invalidates a pool when actual SQL credentials or target change", async () => {
    await executeCompiledQuery(settings, compiled);
    await executeCompiledQuery(
      { ...settings, password: "changed-secret" },
      compiled,
    );
    expect(count("connect")).toBe(2);
    expect(count("pool:close")).toBe(1);
    expect(count("pool:create")).toBe(2);
  });
  it("does not read the driver for an already-cancelled request, but reports timing zeros", async () => {
    const observe = vi.fn();
    await expect(
      executeCompiledQuery(settings, compiled, AbortSignal.abort(), observe),
    ).rejects.toBeInstanceOf(QueryAbortedError);
    expect(state.events).toEqual([]);
    expect(observe).toHaveBeenCalledWith({
      poolAcquireMs: 0,
      connectMs: 0,
      sendToFirstRowMs: 0,
      fetchMs: 0,
    });
  });
  it("holds the lease until cancellation acknowledgement, then reuses the healthy session", async () => {
    const controller = new AbortController();
    state.wait = true;
    state.cancelAck = false;
    const ready = started();
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    const rejection =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    controller.abort();
    await Promise.resolve();
    expect(count("cancel")).toBe(1);
    expect(count("release")).toBe(0);
    state.controls[0].reject(
      Object.assign(new Error("ack"), { code: "ECANCEL" }),
    );
    await rejection;
    expect(count("release")).toBe(1);
    expect(count("discard")).toBe(0);
    state.wait = false;
    await executeCompiledQuery(settings, compiled);
    expect(count("connect")).toBe(1);
  });
  it("explicitly cancels at 30 seconds even if the driver ignores requestTimeout, discards it, and allows a retry", async () => {
    vi.useFakeTimers();
    state.wait = true;
    const ready = started();
    const operation = executeCompiledQuery(settings, compiled);
    const rejection =
      expect(operation).rejects.toBeInstanceOf(QueryTimeoutError);
    await ready;
    await vi.advanceTimersByTimeAsync(QUERY_REQUEST_TIMEOUT_MS);
    await rejection;
    expect(count("cancel")).toBe(1);
    expect(count("discard")).toBe(1);
    expect(count("release")).toBe(0);
    expect(count("socketDestroy")).toBe(1);
    state.wait = false;
    await executeCompiledQuery(settings, compiled);
    expect(count("connect")).toBe(1);
    expect(count("select")).toBe(2);
    expect(count("release")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("force-closes a non-acknowledging session after a bounded grace period before freeing the slot", async () => {
    vi.useFakeTimers();
    state.wait = true;
    state.cancelAck = false;
    const ready = started();
    const operation = executeCompiledQuery(settings, compiled);
    const rejection = expect(operation).rejects.toMatchObject({
      code: "ETIMEOUT",
    });
    await ready;
    await vi.advanceTimersByTimeAsync(QUERY_REQUEST_TIMEOUT_MS);
    expect(count("cancel")).toBe(1);
    expect(count("discard")).toBe(0);
    await vi.advanceTimersByTimeAsync(QUERY_CANCEL_GRACE_MS);
    await rejection;
    expect(state.events.indexOf("destroy")).toBeLessThan(
      state.events.indexOf("discard"),
    );
    expect(count("discard")).toBe(1);
    expect(count("socketDestroy")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("explicitly cancels/discards a driver-side ETIMEOUT and never returns a timed-out lease as healthy", async () => {
    state.driverTimeout = true;
    await expect(
      executeCompiledQuery(settings, compiled),
    ).rejects.toMatchObject({ code: "ETIMEOUT" });
    expect(count("cancel")).toBe(1);
    expect(count("discard")).toBe(1);
    expect(count("release")).toBe(0);
  });
  it("closes a failed login pool without releasing an unreserved resource", async () => {
    state.failConnect = true;
    await expect(executeCompiledQuery(settings, compiled)).rejects.toThrow(
      "connection refused",
    );
    await closeQueryPools();
    expect(count("pool:close")).toBe(1);
    expect(count("reserve")).toBe(0);
  });
  it("cancels while login is opening without sending SQL or closing a shared in-flight login", async () => {
    const controller = new AbortController();
    state.waitConnect = true;
    const ready = started("connectStarted");
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    const rejection =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    controller.abort();
    await rejection;
    expect(count("select")).toBe(0);
    expect(count("pool:close")).toBe(0);
    state.resumeConnect?.();
    state.waitConnect = false;
    await executeCompiledQuery(settings, compiled);
    expect(count("connect")).toBe(1);
  });
  it("returns a lease acquired after cancellation without ever issuing SQL", async () => {
    const controller = new AbortController();
    state.waitAcquire = true;
    const ready = started("acquireStarted");
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    const rejection =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    controller.abort();
    await rejection;
    state.resumeAcquire?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(count("select")).toBe(0);
    expect(count("release")).toBe(1);
  });
  it("separates physical login, queue checkout, first row, and streamed fetch durations", async () => {
    vi.useFakeTimers();
    state.dialDelay = 7;
    state.rowDelays = true;
    const observe = vi.fn();
    const operation = executeCompiledQuery(
      settings,
      compiled,
      undefined,
      observe,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await operation).toEqual([{ total: 4 }, { total: 5 }]);
    const timing = observe.mock.calls[0][0] as Partial<QueryTimings>;
    expect(timing.connectMs).toBe(14); // login probe plus the first real lease
    expect(timing.poolAcquireMs).toBe(0);
    expect(timing.sendToFirstRowMs).toBe(10);
    expect(timing.fetchMs).toBe(30);
    state.rowDelays = false;
    const second = vi.fn();
    await executeCompiledQuery(settings, compiled, undefined, second);
    expect(second.mock.calls[0][0].connectMs).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not charge an old cancelled checkout's login time to the next warm borrower", async () => {
    vi.useFakeTimers();
    state.dialDelay = 7;
    state.waitAcquire = true;
    const controller = new AbortController();
    const acquiring = started("acquireStarted");
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    const rejection =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await vi.advanceTimersByTimeAsync(10);
    await acquiring;
    controller.abort();
    await rejection;
    state.waitAcquire = false;
    state.resumeAcquire?.();
    await vi.advanceTimersByTimeAsync(10);
    const observe = vi.fn();
    await executeCompiledQuery(settings, compiled, undefined, observe);
    expect(observe.mock.calls[0][0]).toMatchObject({
      connectMs: 0,
      poolAcquireMs: 0,
    });
    expect(count("connect")).toBe(1);
    expect(count("select")).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds global active queries and queued waiters and removes aborted waiters", async () => {
    state.wait = true;
    let readyCount = 0;
    const ready = new Promise<void>((resolve) => {
      state.queryStarted = () => {
        if (++readyCount === 4) resolve();
      };
    });
    const controllers = Array.from({ length: 21 }, () => new AbortController());
    const operations = controllers.map((controller) =>
      executeCompiledQuery(settings, compiled, controller.signal),
    );
    const results = Promise.allSettled(operations);
    await ready;
    expect(count("select")).toBe(4);
    controllers.forEach((controller) => controller.abort());
    const statuses = await results;
    expect(
      statuses.filter(
        (value) =>
          value.status === "rejected" &&
          (value.reason as { status?: number }).status === 503,
      ),
    ).toHaveLength(1);
    expect(count("select")).toBe(4);
    expect(count("cancel")).toBe(4);
  });
  it("bounds pool queue waiting to 30 seconds and reports the failed wait timing", async () => {
    vi.useFakeTimers();
    state.wait = true;
    state.cancelAck = false;
    let readyCount = 0;
    const ready = new Promise<void>((resolve) => {
      state.queryStarted = () => {
        if (++readyCount === 4) resolve();
      };
    });
    const active = Array.from({ length: 4 }, () =>
      executeCompiledQuery(settings, compiled),
    );
    const completed = Promise.allSettled(active);
    await ready;
    const observe = vi.fn();
    const queued = executeCompiledQuery(settings, compiled, undefined, observe);
    const rejected = expect(queued).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("waiting"),
    });
    await vi.advanceTimersByTimeAsync(QUERY_REQUEST_TIMEOUT_MS);
    await rejected;
    await vi.advanceTimersByTimeAsync(QUERY_CANCEL_GRACE_MS);
    await completed;
    expect(observe.mock.calls[0][0]).toMatchObject({
      poolAcquireMs: 30_000,
      connectMs: 0,
      sendToFirstRowMs: 0,
      fetchMs: 0,
    });
    expect(count("select")).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("drains active work and rejects queued requests during explicit shutdown", async () => {
    state.wait = true;
    const ready = started();
    const operation = executeCompiledQuery(settings, compiled);
    const rejected =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    await closeQueryPools();
    await rejected;
    expect(count("cancel")).toBe(1);
    expect(count("release")).toBe(1);
    expect(count("pool:close")).toBe(1);
  });
  it("rejects new arrivals while shutdown drains active requests, then permits a fresh pool", async () => {
    state.wait = true;
    state.cancelAck = false;
    const ready = started();
    const operation = executeCompiledQuery(settings, compiled);
    const rejected =
      expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    await ready;
    const closing = closeQueryPools();
    await expect(
      executeCompiledQuery(settings, compiled),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("shutting down"),
    });
    expect(count("pool:create")).toBe(1);
    state.controls[0].reject(new Error("cancel acknowledged"));
    await rejected;
    await closing;
    state.wait = false;
    await executeCompiledQuery(settings, compiled);
    expect(count("pool:create")).toBe(2);
    expect(count("select")).toBe(2);
  });
  it("keeps an old connection alive only until its in-flight query settles when settings change", async () => {
    state.wait = true;
    const ready = started();
    const first = executeCompiledQuery(settings, compiled);
    await ready;
    state.wait = false;
    await executeCompiledQuery(
      { ...settings, database: "OtherDatabase" },
      compiled,
    );
    expect(count("pool:close")).toBe(0);
    state.controls[0].resolve();
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(count("pool:close")).toBe(1);
    expect(count("connect")).toBe(2);
  });
});
