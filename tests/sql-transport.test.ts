import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqlTransport } from "@/lib/runner/sql-transport";

const state = vi.hoisted(() => ({
  events: [] as string[],
  connections: [] as unknown[],
  inputs: [] as { name: string; value: unknown }[],
  timeout: 0,
}));
vi.mock("mssql", async () => {
  const { EventEmitter } = await import("node:events");
  const physical = { session: 123 };
  class ConnectionPool extends EventEmitter {
    connected = true;
    collation = { codepage: 65001 };
    constructor(public config: unknown) {
      super();
    }
    async connect() {
      state.events.push("connect");
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
    constructor(
      public parent: Parent,
      options: { requestTimeout: number },
    ) {
      super();
      state.timeout = options.requestTimeout;
    }
    input(name: string, _type: unknown, value: unknown) {
      state.inputs.push({ name, value });
      return this;
    }
    async perform(text: string) {
      const connection = await new Promise<unknown>((resolve, reject) =>
        this.parent.acquire(this, (error, connection) =>
          error ? reject(error) : resolve(connection),
        ),
      );
      state.connections.push(connection);
      this.emit("info", { message: "PRINT message", class: 0 });
      this.parent.release(connection);
      state.events.push(text.startsWith("IF @@") ? "rollback" : "request");
      const recordset = text.includes("FROM [etl].[run_log]")
        ? [
            { step: "01_staging", rows_out: 10 },
            { step: "04_fact", rows_out: 9, rows_rejected: 1 },
          ]
        : text.includes("FROM [dw].[reject_rows]")
          ? [
              {
                source_row_number: 3,
                reason: "bad number",
                raw_json: '{"value":"bad"}',
              },
            ]
          : [];
      return { rowsAffected: [2, 3], recordset };
    }
    batch(text: string) {
      return this.perform(text);
    }
    query(text: string) {
      return this.perform(text);
    }
    cancel() {
      state.events.push("cancel");
    }
  }
  return {
    default: { ConnectionPool, Request, UniqueIdentifier: "UniqueIdentifier" },
  };
});

beforeEach(() => {
  state.events = [];
  state.connections = [];
  state.inputs = [];
  state.timeout = 0;
});
describe("pinned tedious transport", () => {
  it("reserves one physical connection for every batch, summary query, and rollback until close", async () => {
    const info = vi.fn();
    const transport = createSqlTransport(
      {
        server: "localhost",
        port: 1433,
        database: "DataForge",
        user: "sql-login",
        password: "test-only",
        encrypt: true,
        trustServerCertificate: true,
        stagingFolder: "/tmp",
      },
      600_000,
      info,
    );
    await transport.connect();
    expect(await transport.batch("SELECT 1;")).toEqual({
      rowsAffected: [2, 3],
    });
    await transport.batch("SELECT 2;");
    const summary = await transport.summary(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(summary).toEqual({
      rowsStaged: 10,
      rowsLoaded: 9,
      rowsRejected: 1,
      rejected: [
        {
          sourceRowNumber: 3,
          reason: "bad number",
          rawJson: '{"value":"bad"}',
        },
      ],
    });
    await transport.rollback();
    expect(state.events.filter((e) => e === "reserve")).toHaveLength(1);
    expect(state.events).not.toContain("release");
    expect(new Set(state.connections).size).toBe(1);
    expect(state.inputs).toEqual([
      { name: "runId", value: "11111111-1111-4111-8111-111111111111" },
      { name: "runId", value: "11111111-1111-4111-8111-111111111111" },
    ]);
    expect(state.timeout).toBe(10_000);
    expect(info).toHaveBeenCalled();
    await transport.close();
    expect(state.events.slice(-2)).toEqual(["release", "close"]);
  });
});
