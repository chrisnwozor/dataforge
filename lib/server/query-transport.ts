import { createHash } from "node:crypto";
import type { ConnectionPool, Request, config as SqlConfig } from "mssql";
import type { CompiledQuery, QueryTimings } from "@/lib/semantic/query/types";
import type { SqlParameter } from "@/lib/semantic/types";
import { connectionConfig, type SqlConnectionSettings } from "./connection";
import { HttpError } from "./http";
import { SqlStatisticsCollector } from "./sql-statistics";

export const QUERY_REQUEST_TIMEOUT_MS = 30_000;
export const QUERY_CANCEL_GRACE_MS = 5_000;
const MAX_CONNECTIONS = 4;
const MAX_WAITING_QUERIES = 16;
interface PhysicalConnection {
  hasError?: boolean;
  closed?: boolean;
  close(): void;
  socket?: { destroy(): void };
}
// Public mssql acquire/release APIs are omitted from @types/mssql.
interface ReservablePool extends ConnectionPool {
  config: SqlConfig;
  collation: unknown;
  acquire(requester: unknown): Promise<PhysicalConnection>;
  release(connection: PhysicalConnection): void;
  _poolCreate(): Promise<PhysicalConnection>;
}
type RequestConstructor = new (
  parent: ConnectionPool,
  overrides?: { requestTimeout: number },
) => Request;
interface PoolEntry {
  key: string;
  pool: ReservablePool;
  ready: Promise<void>;
  connected: boolean;
  retired: boolean;
  users: number;
  creationTimes: WeakMap<PhysicalConnection, number>;
  idle: Set<() => void>;
  closing?: Promise<void>;
}
interface Waiter {
  enter(): void;
  reject(error: Error): void;
}
interface PoolManager {
  current?: PoolEntry;
  entries: Set<PoolEntry>;
  active: number;
  queue: Waiter[];
  cancel: Set<() => void>;
  idle: Set<() => void>;
  shuttingDown: boolean;
  closing?: Promise<void>;
}
const globals = globalThis as typeof globalThis & {
  dataforgeQueryPools?: PoolManager;
};
const manager = (globals.dataforgeQueryPools ??= {
  entries: new Set(),
  active: 0,
  queue: [],
  cancel: new Set(),
  idle: new Set(),
  shuttingDown: false,
});
manager.idle ??= new Set();
manager.shuttingDown ??= false;
let driverPromise: Promise<typeof import("mssql")> | undefined;
export class QueryAbortedError extends Error {
  constructor() {
    super("The query was cancelled.");
    this.name = "QueryAbortedError";
  }
}
export class QueryTimeoutError extends Error {
  readonly code = "ETIMEOUT";
  constructor() {
    super("The query exceeded the 30-second timeout.");
    this.name = "QueryTimeoutError";
  }
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new QueryAbortedError();
}
const rounded = (milliseconds: number) =>
  Math.round(Math.max(0, milliseconds) * 100) / 100;

/** Bound both open sessions and the application queue, including across configuration changes. */
function enterQueue(signal?: AbortSignal): Promise<() => void> {
  checkAbort(signal);
  if (manager.shuttingDown)
    return Promise.reject(
      new HttpError(503, "The query pool is shutting down. Try again shortly."),
    );
  return new Promise((resolve, reject) => {
    const finish = () => {
      manager.active--;
      manager.queue.shift()?.enter();
      if (!manager.active) {
        for (const idle of manager.idle) idle();
        manager.idle.clear();
      }
    };
    if (manager.active < MAX_CONNECTIONS) {
      manager.active++;
      resolve(finish);
      return;
    }
    if (manager.queue.length >= MAX_WAITING_QUERIES) {
      reject(
        new HttpError(
          503,
          "The query queue is full. Wait for an active query to finish and try again.",
        ),
      );
      return;
    }
    const abort = () => {
      const index = manager.queue.indexOf(waiter);
      if (index >= 0) manager.queue.splice(index, 1);
      clearTimeout(timer);
      reject(new QueryAbortedError());
    };
    const timer = setTimeout(() => {
      const index = manager.queue.indexOf(waiter);
      if (index >= 0) manager.queue.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(
        new HttpError(
          504,
          "Timed out waiting for an available SQL Server query connection.",
        ),
      );
    }, QUERY_REQUEST_TIMEOUT_MS);
    const waiter: Waiter = {
      enter() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        manager.active++;
        resolve(finish);
      },
      reject(error) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error);
      },
    };
    manager.queue.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
function closeRetired(entry: PoolEntry): Promise<void> | undefined {
  if (!entry.retired || entry.users) return entry.closing;
  return (entry.closing ??= (async () => {
    // mssql cannot close while its initial login probe is still connecting.
    await entry.ready.catch(() => {});
    await entry.pool.close().catch(() => {});
    entry.pool.config.password = undefined;
    manager.entries.delete(entry);
  })());
}
function getPool(
  sql: typeof import("mssql"),
  settings: SqlConnectionSettings,
): PoolEntry {
  // Store only a one-way key; credentials are never used in logs or cache responses.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        settings.server,
        settings.port,
        settings.database,
        settings.user,
        settings.password,
        settings.encrypt,
        settings.trustServerCertificate,
      ]),
    )
    .digest("hex");
  if (manager.current?.key === key && !manager.current.retired)
    return manager.current;
  if (manager.current) {
    manager.current.retired = true;
    void closeRetired(manager.current);
  }
  const config = connectionConfig(settings, QUERY_REQUEST_TIMEOUT_MS);
  config.pool = {
    ...config.pool,
    max: MAX_CONNECTIONS,
    min: 0,
    acquireTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
  };
  // Avoid an extra SELECT 1 on every checkout; reject closed/poisoned sockets locally.
  config.validateConnection = "socket";
  config.options = { ...config.options, cancelTimeout: QUERY_CANCEL_GRACE_MS };
  const pool = new sql.ConnectionPool(config) as ReservablePool;
  pool.on("error", () => {});
  const creationTimes = new WeakMap<PhysicalConnection, number>();
  // mssql opens a login-probe connection in connect(), then creates real leases
  // lazily. Attribute the assigned lease's dial time rather than calling that
  // work queue wait. This adapter is covered against the installed tedious API.
  const createConnection = pool._poolCreate.bind(pool);
  pool._poolCreate = async () => {
    const start = performance.now();
    const connection = await createConnection();
    creationTimes.set(connection, performance.now() - start);
    return connection;
  };
  const entry: PoolEntry = {
    key,
    pool,
    ready: Promise.resolve(),
    connected: false,
    retired: false,
    users: 0,
    creationTimes,
    idle: new Set(),
  };
  manager.entries.add(entry);
  manager.current = entry;
  entry.ready = Promise.resolve()
    .then(() => pool.connect())
    .then(
      () => {
        entry.connected = true;
      },
      (error) => {
        entry.retired = true;
        if (manager.current === entry) manager.current = undefined;
        throw error;
      },
    );
  // A caller may disconnect while the shared login is in flight.
  void entry.ready
    .catch(() => {})
    .finally(() => {
      void closeRetired(entry);
    });
  return entry;
}
/** Application/test shutdown hook; healthy pools otherwise remain open between queries. */
export function closeQueryPools(): Promise<void> {
  if (manager.closing) return manager.closing;
  manager.shuttingDown = true;
  const closing = (async () => {
    manager.current = undefined;
    for (const waiter of manager.queue.splice(0))
      waiter.reject(new QueryAbortedError());
    for (const entry of manager.entries) entry.retired = true;
    for (const cancel of manager.cancel) cancel();
    if (manager.active)
      await new Promise<void>((resolve) => manager.idle.add(resolve));
    await Promise.all(
      [...manager.entries].map(async (entry) => {
        // Active requests hold their leases until acknowledgement or forced socket close.
        if (entry.users)
          await new Promise<void>((resolve) => entry.idle.add(resolve));
        await closeRetired(entry);
      }),
    );
  })();
  manager.closing = closing.finally(() => {
    manager.shuttingDown = false;
    manager.closing = undefined;
  });
  return manager.closing;
}
function bindParameter(
  request: Request,
  sql: typeof import("mssql"),
  parameter: SqlParameter,
): void {
  if (!/^[_A-Za-z][_A-Za-z0-9]{0,127}$/.test(parameter.name))
    throw new Error("Invalid generated parameter name.");
  const value = parameter.value;
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("A query parameter is not a finite number.");
  if (parameter.name === "__df_limit") {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 50_001
    )
      throw new Error("Invalid generated row limit.");
    request.input(parameter.name, sql.Int, value);
  } else if (parameter.type === "date" && value !== null) {
    const date = new Date(String(value));
    if (!Number.isFinite(date.getTime()))
      throw new Error("Invalid date parameter.");
    request.input(parameter.name, sql.DateTime2, date);
  } else if (parameter.type === "boolean" || typeof value === "boolean")
    request.input(parameter.name, sql.Bit, value);
  else if (parameter.type === "number" || typeof value === "number")
    request.input(
      parameter.name,
      typeof value === "number" && Number.isSafeInteger(value)
        ? sql.BigInt
        : sql.Float,
      value,
    );
  else request.input(parameter.name, sql.NVarChar(sql.MAX), value);
}
/** Only server-produced query batches reach this transport; no endpoint accepts SQL text. */
export async function executeCompiledQuery(
  settings: SqlConnectionSettings,
  compiled: CompiledQuery,
  signal?: AbortSignal,
  observe?: (timings: Partial<QueryTimings>) => void,
): Promise<Record<string, unknown>[]> {
  const timings = {
    poolAcquireMs: 0,
    connectMs: 0,
    sendToFirstRowMs: 0,
    fetchMs: 0,
  };
  let leave: (() => void) | undefined;
  let entry: PoolEntry | undefined;
  let physical: PhysicalConnection | undefined;
  let request: Request | undefined;
  let cancelReason: Error | undefined;
  let poisoned = false;
  let destroyed = false;
  let settled = false;
  let sentAt: number | undefined;
  let firstRowAt: number | undefined;
  let finishedAt: number | undefined;
  let statisticsEnabled = false;
  let setStatistics: ((enabled: boolean) => Promise<void>) | undefined;
  const statistics = compiled.diagnostics
    ? new SqlStatisticsCollector()
    : undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let cancelResolve!: (reason: Error) => void;
  const stopped = new Promise<Error>((resolve) => {
    cancelResolve = resolve;
  });
  const cancel = (reason: Error) => {
    if (cancelReason) return;
    cancelReason = reason;
    try {
      request?.cancel();
    } catch {
      poisoned = true;
    }
    cancelResolve(reason);
  };
  const abort = () => cancel(new QueryAbortedError());
  const shutdown = () => abort();
  const checkCancelled = () => {
    if (cancelReason) throw cancelReason;
    checkAbort(signal);
  };
  const poison = () => {
    if (!physical) return;
    poisoned = true;
    physical.hasError = true;
    if (destroyed) return;
    destroyed = true;
    try {
      physical.close();
    } catch {
      /* The socket is destroyed below as the final fallback. */
    }
    try {
      physical.socket?.destroy();
    } catch {
      /* A closed socket cannot execute another query. */
    }
  };
  try {
    checkCancelled();
    const queuedAt = performance.now();
    try {
      leave = await enterQueue(signal);
    } finally {
      timings.poolAcquireMs = performance.now() - queuedAt;
    }
    manager.cancel.add(shutdown);
    signal?.addEventListener("abort", abort, { once: true });
    if (manager.shuttingDown) throw new QueryAbortedError();
    checkCancelled();
    const sql = await (driverPromise ??= import("mssql").then(
      (module) => module.default,
    ));
    checkCancelled();
    if (manager.shuttingDown) throw new QueryAbortedError();
    entry = getPool(sql, settings);
    entry.users++;
    const connectStart = performance.now();
    const wasConnected = entry.connected;
    let connection: boolean;
    try {
      connection = await Promise.race([
        entry.ready.then(() => true),
        stopped.then(() => false),
      ]);
    } finally {
      timings.connectMs = wasConnected ? 0 : performance.now() - connectStart;
    }
    if (!connection) throw cancelReason;
    checkCancelled();
    const acquireStart = performance.now();
    const acquisition = entry.pool.acquire(entry.pool);
    let acquired: { connection: PhysicalConnection } | undefined;
    let acquireMs = 0;
    try {
      acquired = await Promise.race([
        acquisition.then((connection) => ({ connection })),
        stopped.then(() => undefined),
      ]);
    } finally {
      acquireMs = performance.now() - acquireStart;
      timings.poolAcquireMs += acquireMs;
    }
    if (!acquired) {
      const pool = entry.pool;
      void acquisition.then(
        (connection) => pool.release(connection),
        () => {},
      );
      throw cancelReason;
    }
    physical = acquired.connection;
    // A connection may have started opening for an earlier cancelled checkout.
    // Attribute only the login time this caller actually waited for.
    const dialMs = Math.min(entry.creationTimes.get(physical) ?? 0, acquireMs);
    entry.creationTimes.delete(physical);
    timings.connectMs += dialMs;
    timings.poolAcquireMs = Math.max(0, timings.poolAcquireMs - dialMs);
    checkCancelled();
    const pool = entry.pool;
    const parent = {
      connected: true,
      config: pool.config,
      collation: pool.collation,
      acquire(
        _request: unknown,
        callback: (
          error: Error | null,
          connection: unknown,
          config: SqlConfig,
        ) => void,
      ) {
        process.nextTick(callback, null, physical, pool.config);
      },
      release() {},
    } as unknown as ConnectionPool;
    const RequestClass = sql.Request as unknown as RequestConstructor;
    setStatistics = async (enabled) => {
      // SET is sent before the main RPC so SQL Server can report that RPC's
      // initial parse/compile time, not merely deferred statement compiles.
      const setting = new RequestClass(parent, {
        requestTimeout: QUERY_CANCEL_GRACE_MS,
      });
      setting.on("error", () => {});
      request = setting;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // SQLBatch keeps this SET at connection scope. request.query would wrap
      // it in sp_executesql, whose SET options are restored when that RPC ends.
      const operation = setting.batch(
        `SET STATISTICS TIME ${enabled ? "ON" : "OFF"};`,
      );
      try {
        const outcome = await Promise.race([
          operation.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ error }),
          ),
          stopped.then((error) => ({ error })),
          new Promise<{ error: Error }>((resolve) => {
            timer = setTimeout(() => {
              try {
                setting.cancel();
              } catch {
                /* The physical socket is closed below. */
              }
              resolve({
                error: new HttpError(
                  504,
                  "SQL Server diagnostics setup or cleanup timed out.",
                ),
              });
            }, QUERY_CANCEL_GRACE_MS);
          }),
        ]);
        if ("error" in outcome) {
          poison();
          throw outcome.error;
        }
        statisticsEnabled = enabled;
      } finally {
        if (timer) clearTimeout(timer);
        if (request === setting) request = undefined;
      }
    };
    if (compiled.diagnostics) await setStatistics(true);
    checkCancelled();
    request = new RequestClass(parent, {
      requestTimeout: QUERY_REQUEST_TIMEOUT_MS,
    });
    for (const parameter of compiled.params)
      bindParameter(request, sql, parameter);
    request.stream = true;
    const records: Record<string, unknown>[] = [];
    let streamError: unknown;
    request.on("row", (row: Record<string, unknown>) => {
      if (firstRowAt === undefined) firstRowAt = performance.now();
      if (!cancelReason) records.push(row);
    });
    request.on("error", (error: unknown) => {
      streamError ??= error;
      if ((error as { code?: string } | null)?.code === "ETIMEOUT")
        cancel(new QueryTimeoutError());
    });
    if (statistics)
      request.on("info", (info: { message?: unknown }) => {
        if (typeof info.message === "string") statistics.add(info.message);
      });
    checkCancelled();
    sentAt = performance.now();
    deadline = setTimeout(
      () => cancel(new QueryTimeoutError()),
      QUERY_REQUEST_TIMEOUT_MS,
    );
    const operation = request
      .query(compiled.sql)
      .then((result) => {
        if (streamError) throw streamError;
        return records.length ? records : (result.recordset ?? records);
      })
      .finally(() => {
        settled = true;
        finishedAt = performance.now();
      });
    const outcome = await Promise.race([
      operation.then(
        (rows) => ({ rows }),
        (error) => ({ error }),
      ),
      stopped.then((reason) => ({ cancelled: reason })),
    ]);
    if ("cancelled" in outcome) {
      await Promise.race([
        operation.catch(() => {}),
        new Promise<void>((resolve) => {
          grace = setTimeout(() => {
            poison();
            resolve();
          }, QUERY_CANCEL_GRACE_MS);
        }),
      ]);
      if (
        !settled ||
        cancelReason instanceof QueryTimeoutError ||
        compiled.materialized ||
        compiled.diagnostics
      )
        poison();
      throw outcome.cancelled;
    }
    if ("error" in outcome) {
      if ((outcome.error as { code?: string } | null)?.code === "ETIMEOUT") {
        cancel(new QueryTimeoutError());
        poison();
        throw cancelReason;
      }
      throw outcome.error;
    }
    if (cancelReason) {
      if (compiled.materialized || compiled.diagnostics) poison();
      throw cancelReason;
    }
    return outcome.rows;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (grace) clearTimeout(grace);
    signal?.removeEventListener("abort", abort);
    manager.cancel.delete(shutdown);
    if (statisticsEnabled && !poisoned && !cancelReason) {
      try {
        await setStatistics?.(false);
      } catch {
        poison();
      }
    }
    if (cancelReason && (compiled.materialized || compiled.diagnostics))
      poison();
    if (sentAt !== undefined) {
      const finished = finishedAt ?? performance.now();
      timings.sendToFirstRowMs = (firstRowAt ?? finished) - sentAt;
      timings.fetchMs = firstRowAt === undefined ? 0 : finished - firstRowAt;
    }
    if (physical && entry) {
      if (poisoned) poison();
      entry.pool.release(physical);
    }
    if (entry) {
      entry.users--;
      if (!entry.users) {
        for (const idle of entry.idle) idle();
        entry.idle.clear();
      }
      void closeRetired(entry);
    }
    leave?.();
    observe?.({
      ...Object.fromEntries(
        Object.entries(timings).map(([key, value]) => [key, rounded(value)]),
      ),
      ...statistics?.snapshot(),
    });
  }
}
