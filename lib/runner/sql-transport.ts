import type { ConnectionPool, Request, config as SqlConfig } from "mssql";
import {
  connectionConfig,
  type SqlConnectionSettings,
} from "@/lib/server/connection";
import type { RejectedRow } from "./types";

export interface SqlInfo {
  message: string;
  number?: number;
  class?: number;
  lineNumber?: number;
}

export interface BatchResult {
  rowsAffected: number[];
}
export interface SqlRunSummary {
  rowsStaged: number;
  rowsLoaded: number;
  rowsRejected: number;
  rejected: RejectedRow[];
}
export interface SqlTransport {
  connect(): Promise<void>;
  batch(sql: string): Promise<BatchResult>;
  summary(runId: string): Promise<SqlRunSummary>;
  rollback(): Promise<void>;
  cancel(): void;
  close(): Promise<void>;
}

// acquire/release are documented node-mssql APIs, omitted from @types/mssql.
interface ReservablePool extends ConnectionPool {
  config: SqlConfig;
  collation: unknown;
  acquire(requester: unknown): Promise<unknown>;
  release(connection: unknown): void;
}

type RequestConstructor = new (
  parent: ConnectionPool,
  overrides?: { requestTimeout: number },
) => Request;

/** Hold one physical tedious connection without an outer transaction that scripts could roll back. */
export function createSqlTransport(
  settings: SqlConnectionSettings,
  timeoutMs: number,
  onInfo: (info: SqlInfo) => void,
): SqlTransport {
  let driver: typeof import("mssql") | undefined;
  let pool: ReservablePool | undefined;
  let parent: ConnectionPool | undefined;
  let physical: unknown;
  let active: Request | undefined;
  let pending: Promise<unknown> | undefined;

  async function request<T>(
    kind: "batch" | "query",
    text: string,
    runId?: string,
    timeout = timeoutMs,
  ) {
    if (!driver || !parent || !physical)
      throw new Error("SQL Server connection is not open.");
    if (active) throw new Error("Another SQL request is still in progress.");
    const RequestClass = driver.Request as unknown as RequestConstructor;
    const current = new RequestClass(parent, { requestTimeout: timeout });
    current.on("info", onInfo);
    if (runId) current.input("runId", driver.UniqueIdentifier, runId);
    active = current;
    const operation =
      kind === "batch" ? current.batch<T>(text) : current.query<T>(text);
    pending = operation;
    try {
      return await operation;
    } finally {
      current.removeListener("info", onInfo);
      if (active === current) active = undefined;
      if (pending === operation) pending = undefined;
    }
  }

  return {
    async connect() {
      const mssqlModule = await import("mssql");
      driver = mssqlModule.default;
      const config = connectionConfig(settings, timeoutMs);
      config.pool = { ...config.pool, max: 1, min: 1 };
      const created = new driver.ConnectionPool(config) as ReservablePool;
      pool = created;
      // All request failures are handled by their promises; never print pool config or credentials.
      created.on("error", () => {});
      await created.connect();
      physical = await created.acquire(created);
      // Request accepts the same acquire/release contract used by Transaction.
      // Each batch borrows this reserved connection; release waits until close().
      parent = {
        connected: true,
        config: created.config,
        collation: created.collation,
        acquire(
          _request: unknown,
          callback: (
            error: Error | null,
            connection: unknown,
            config: SqlConfig,
          ) => void,
        ) {
          process.nextTick(callback, null, physical, created.config);
        },
        release() {},
      } as unknown as ConnectionPool;
    },
    async batch(sql) {
      const result = await request<Record<string, unknown>>("batch", sql);
      return {
        rowsAffected: result.rowsAffected.filter(
          (count) => Number.isSafeInteger(count) && count >= 0,
        ),
      };
    },
    async summary(runId) {
      const result = await request<{
        step: string;
        rows_in: number;
        rows_out: number;
        rows_rejected: number;
      }>(
        "query",
        `
        SELECT [step], [rows_in], [rows_out], [rows_rejected]
        FROM [etl].[run_log] WHERE [run_id] = @runId AND [status] = N'Succeeded'
        ORDER BY [finished_at] ASC, [started_at] ASC;
      `,
        runId,
      );
      const rows = result.recordset;
      const staging = rows.filter((row) => row.step === "01_staging").at(-1);
      const fact = rows.filter((row) => row.step === "04_fact").at(-1);
      if (!staging || !fact)
        throw new Error(
          "SQL Server did not return the expected run summary for this run ID.",
        );
      const rejected = await request<{
        source_row_number: number;
        reason: string;
        raw_json: string;
      }>(
        "query",
        `
        SELECT TOP (100) [source_row_number], [reason], [raw_json]
        FROM [dw].[reject_rows] WHERE [run_id] = @runId ORDER BY [source_row_number] ASC;
      `,
        runId,
      );
      return {
        rowsStaged: Number(staging.rows_out),
        rowsLoaded: Number(fact.rows_out),
        rowsRejected: Number(fact.rows_rejected),
        rejected: rejected.recordset.map((row) => ({
          sourceRowNumber: Number(row.source_row_number),
          reason: String(row.reason),
          rawJson: String(row.raw_json),
        })),
      };
    },
    async rollback() {
      // This query is fixed server-side housekeeping, never client-provided SQL.
      await request(
        "batch",
        "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;",
        undefined,
        Math.min(timeoutMs, 10_000),
      );
    },
    cancel() {
      active?.cancel();
    },
    async close() {
      if (pending) await pending.catch(() => {});
      if (pool && physical) pool.release(physical);
      physical = undefined;
      parent = undefined;
      await pool?.close();
      pool = undefined;
    },
  };
}
