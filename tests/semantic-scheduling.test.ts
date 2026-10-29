import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery, QueryTimings } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { semanticCache } from "@/lib/semantic/query/cache";
import { runSemanticQuery, getDistinctValues } from "@/lib/server/semantic-query";
import { queryScheduler } from "@/lib/server/query-scheduler";

const state = vi.hoisted(() => ({
  calls: [] as { compiled: CompiledQuery; signal: AbortSignal; timeoutMs: number }[],
  execute: undefined as undefined | ((compiled: CompiledQuery, signal: AbortSignal, report?: (value: Partial<QueryTimings>) => void) => Promise<Record<string, unknown>[]>),
}));
const projectId = "11111111-1111-4111-8111-111111111111";
const model: SemanticModel = {
  projectId, version: "stable", factTableId: "fact", relationships: [], hierarchies: [],
  tables: [{ id: "fact", name: "fact_sales", schema: "dw", sqlName: "fact_sales", kind: "fact", keyColumnId: "key", columns: [
    { id: "key", tableId: "fact", name: "Key", sqlName: "key", type: "number", role: "key" },
    { id: "sales", tableId: "fact", name: "Sales", sqlName: "sales", type: "number", role: "measure-source" },
    { id: "order", tableId: "fact", name: "Order ID", sqlName: "order_id", type: "string", role: "attribute" },
  ] }],
  measures: [{ id: "sales", name: "Sales", expression: "SUM(fact_sales[Sales])", format: "number", folder: "", description: "", isAuto: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
};
vi.mock("@/lib/server/semantic", () => ({
  requireSemanticReady: async () => ({ settings: { server: "shared.sql", port: 1433, database: "Warehouse", password: "not-logged" }, run: { id: "run" } }),
  getSemanticModel: async () => model,
  readSemanticStamp: () => "stable",
}));
vi.mock("@/lib/server/connection", () => ({ readPublicConnection: () => ({ updatedAt: "same" }), friendlyConnectionError: () => "Connection failed." }));
vi.mock("@/lib/server/query-transport", () => ({
  QueryAbortedError: class QueryAbortedError extends Error {},
  executeCompiledQuery: async (_settings: unknown, compiled: CompiledQuery, signal: AbortSignal, report: (value: Partial<QueryTimings>) => void, options: { timeoutMs: number }) => {
    state.calls.push({ compiled, signal, timeoutMs: options.timeoutMs });
    return state.execute ? state.execute(compiled, signal, report) : [{ m0: 100 }];
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); };
beforeEach(async () => {
  await flush();
  queryScheduler.reset(); semanticCache.clear(); state.calls = []; state.execute = undefined;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(async () => { await queryScheduler.close(); queryScheduler.reset(); vi.restoreAllMocks(); });

describe("semantic SQL scheduling through the real service", () => {
  it("queues dashboard tiles without treating each tile as a superseding main query", async () => {
    const first = deferred<Record<string, unknown>[]>();
    state.execute = async () => state.calls.length === 1 ? first.promise : [{ m0: 200 }];
    const one = runSemanticQuery(projectId, { measures: ["sales"], rows: [] }, undefined, undefined, { priority: "dashboard" });
    await flush();
    const two = runSemanticQuery(projectId, { measures: ["sales"], rows: [{ table: "fact", column: "order" }] }, undefined, undefined, { priority: "dashboard" });
    await flush();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].signal.aborted).toBe(false);
    expect(queryScheduler.snapshot()).toEqual({ active: 1, queued: 1 });
    first.resolve([{ m0: 100 }]);
    expect((await one).rows[0].m0).toBe(100);
    expect((await two).rows[0].m0).toBe(200);
    expect(queryScheduler.getRevision(projectId)).toBe(0);
  });

  it("cancels a lower-priority slicer and holds its slot until driver cleanup before starting the main query", async () => {
    const cleanup = deferred<Record<string, unknown>[]>();
    state.execute = async (compiled, signal) => {
      if (compiled.columns[0].key === "value") { await cleanup.promise; if (signal.aborted) throw new Error("Driver cancellation acknowledged."); }
      return [{ m0: 100 }];
    };
    const values = getDistinctValues(projectId, "order").catch((error: unknown) => error);
    await flush(); expect(state.calls).toHaveLength(1);
    const main = runSemanticQuery(projectId, { measures: ["sales"], rows: [] });
    await flush();
    expect(state.calls[0].signal.aborted).toBe(true);
    expect(await values).toMatchObject({ status: 499 });
    expect(state.calls).toHaveLength(1);
    cleanup.resolve([]);
    const result = await main;
    expect(result.rows).toEqual([{ m0: 100 }]);
    expect(result.timings?.queueMs).toBeGreaterThanOrEqual(0);
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1].timeoutMs).toBeGreaterThan(0);
    expect(state.calls[1].timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("a cached main query still cancels obsolete slicer work without executing SQL again", async () => {
    await runSemanticQuery(projectId, { measures: ["sales"], rows: [] });
    const cleanup = deferred<Record<string, unknown>[]>();
    state.execute = () => cleanup.promise;
    const values = getDistinctValues(projectId, "order").catch((error: unknown) => error);
    await flush();
    const cached = await runSemanticQuery(projectId, { measures: ["sales"], rows: [] });
    expect(cached.fromCache).toBe(true);
    expect(await values).toMatchObject({ status: 499 });
    expect(state.calls).toHaveLength(2);
    expect(state.calls[1].signal.aborted).toBe(true);
    expect(queryScheduler.snapshot().active).toBe(1);
    cleanup.resolve([]); await flush();
    expect(queryScheduler.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("propagates caller abort during execution and preserves the observed driver timing", async () => {
    const cleanup = deferred<Record<string, unknown>[]>();
    state.execute = async (_compiled, signal, report) => {
      signal.addEventListener("abort", () => report?.({ sendToFirstRowMs: 3123, poolAcquireMs: 2 }));
      return cleanup.promise;
    };
    const controller = new AbortController();
    const operation = runSemanticQuery(projectId, { measures: ["sales"], rows: [] }, controller.signal).catch((error: unknown) => error);
    await flush(); controller.abort();
    const failure = await operation;
    expect(failure).toMatchObject({ status: 499, queryTimings: { sendToFirstRowMs: 3123, poolAcquireMs: 2 } });
    expect(state.calls[0].signal.aborted).toBe(true);
    expect(queryScheduler.snapshot().active).toBe(1);
    cleanup.resolve([]); await flush();
    expect(queryScheduler.snapshot().active).toBe(0);
  });

  it("serializes totals and a following open slicer under the same project", async () => {
    const mainResult = deferred<Record<string, unknown>[]>();
    state.execute = async (compiled) => compiled.columns[0].key === "value" ? [{ value: "A", count: 1 }] : mainResult.promise;
    const main = runSemanticQuery(projectId, { measures: ["sales"], rows: [] }, undefined, undefined, { priority: "totals" });
    await flush();
    const values = getDistinctValues(projectId, "order");
    await flush(); expect(state.calls).toHaveLength(1);
    expect(queryScheduler.snapshot()).toEqual({ active: 1, queued: 1 });
    mainResult.resolve([{ m0: 100 }]); await main;
    const result = await values;
    expect(result.rows).toEqual([{ value: "A", count: 1 }]);
    expect(state.calls).toHaveLength(2);
  });
});
