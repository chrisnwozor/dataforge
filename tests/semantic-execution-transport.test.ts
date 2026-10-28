import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery } from "@/lib/semantic/query/types";
import {
  executeCompiledQuery,
  QueryAbortedError,
} from "@/lib/server/query-transport";

const state = vi.hoisted(() => ({
  events: [] as string[],
  inputs: [] as { name: string; type: unknown; value: unknown }[],
  timeout: 0,
  failConnect: false,
  waitConnect: false,
  resumeConnect: undefined as (() => void) | undefined,
  wait: false,
  running: undefined as (() => void) | undefined,
}));
vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  const physical = { session: 45 };
  class ConnectionPool extends EventEmitter {
    collation = {};
    constructor(public config: unknown) {
      super();
    }
    async connect() {
      state.events.push("connect");
      if (state.failConnect) throw new Error("connection refused");
      if (state.waitConnect)
        await new Promise<void>((resolve) => {
          state.resumeConnect = resolve;
          state.running?.();
        });
      return this;
    }
    async acquire() {
      state.events.push("reserve");
      return physical;
    }
    release(connection: unknown) {
      expect(connection).toBe(physical);
      state.events.push("release");
    }
    async close() {
      state.events.push("close");
    }
  }
  interface Parent {
    acquire(
      request: unknown,
      callback: (error: Error | null, connection: unknown) => void,
    ): void;
    release(connection: unknown): void;
  }
  class Request extends EventEmitter {
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
      expect(sql).toMatch(/^SELECT/);
      await new Promise<void>((resolve, reject) =>
        this.parent.acquire(this, (error, connection) => {
          expect(connection).toBe(physical);
          if (error) reject(error);
          else resolve();
        }),
      );
      state.events.push("select");
      if (state.wait)
        await new Promise<void>((_, reject) => {
          this.reject = reject;
          state.running?.();
        });
      this.parent.release(physical);
      return { recordset: [{ total: 9 }] };
    }
    cancel() {
      state.events.push("cancel");
      this.reject?.(new Error("cancelled"));
    }
  }
  return {
    default: {
      ConnectionPool,
      Request,
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
  sql: "SELECT TOP (@__limit) SUM([Sales]) AS [total] FROM [dw].[fact_sales]",
  params: [
    { name: "__limit", value: 1001, type: "number" },
    { name: "p1", value: "x'; DROP TABLE y;--", type: "string" },
    { name: "p2", value: true, type: "boolean" },
    { name: "p3", value: 1.5, type: "number" },
    { name: "p4", value: "2024-01-01", type: "date" },
  ],
  columns: [{ key: "total", name: "Sales", role: "measure", type: "number" }],
  limit: 1000,
};

beforeEach(() => {
  state.events = [];
  state.inputs = [];
  state.timeout = 0;
  state.failConnect = false;
  state.waitConnect = false;
  state.resumeConnect = undefined;
  state.wait = false;
  state.running = undefined;
});
describe("read-only semantic SQL transport", () => {
  it("pins one tedious connection, binds values, sets 30 seconds and always releases", async () => {
    expect(await executeCompiledQuery(settings, compiled)).toEqual([
      { total: 9 },
    ]);
    expect(state.events).toEqual([
      "connect",
      "reserve",
      "select",
      "release",
      "close",
    ]);
    expect(state.timeout).toBe(30_000);
    expect(state.inputs[0]).toEqual({
      name: "__limit",
      type: "BigInt",
      value: 1001,
    });
    expect(state.inputs[1].value).toBe("x'; DROP TABLE y;--");
    expect(state.inputs[1].type).toBe("NVarChar(-1)");
    expect(state.inputs[4].value).toEqual(new Date("2024-01-01"));
  });

  it("does not connect for an already-cancelled request", async () => {
    await expect(
      executeCompiledQuery(settings, compiled, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(QueryAbortedError);
    expect(state.events).toEqual([]);
  });

  it("cancels the in-flight SELECT and releases the reserved connection after settling", async () => {
    const controller = new AbortController();
    state.wait = true;
    const running = new Promise<void>((resolve) => {
      state.running = resolve;
    });
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    await running;
    controller.abort();
    await expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    expect(state.events).toEqual([
      "connect",
      "reserve",
      "select",
      "cancel",
      "release",
      "close",
    ]);
  });

  it("closes a failed connection without releasing an unreserved resource", async () => {
    state.failConnect = true;
    await expect(executeCompiledQuery(settings, compiled)).rejects.toThrow(
      "connection refused",
    );
    expect(state.events).toEqual(["connect", "close"]);
  });

  it("does not send a SELECT when cancelled while a connection is opening", async () => {
    const controller = new AbortController();
    state.waitConnect = true;
    const connecting = new Promise<void>((resolve) => {
      state.running = resolve;
    });
    const operation = executeCompiledQuery(
      settings,
      compiled,
      controller.signal,
    );
    await connecting;
    controller.abort();
    state.resumeConnect?.();
    await expect(operation).rejects.toBeInstanceOf(QueryAbortedError);
    expect(state.events).toEqual(["connect", "close"]);
    expect(state.inputs).toEqual([]);
  });
});
