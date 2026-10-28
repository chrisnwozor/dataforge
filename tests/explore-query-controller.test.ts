import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExploreQueryController, buildExploreRequests } from "@/components/explore/use-explore-query";
import { createEmptyView, type ViewConfig } from "@/lib/explore/config";
import type { QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import { buildPivot } from "@/lib/explore/pivot";

const result = (value = 1): QueryResult => ({ columns: [{ key: "m0", name: "Sales", role: "measure", type: "number" }], rows: [{ m0: value }], rowCount: 1, elapsedMs: 12, fromCache: false, sql: "SELECT generated_only", truncated: false });
const view = (): ViewConfig => ({ ...createEmptyView(), values: ["sales"], rows: [{ table: "date", column: "year" }] });
const reply = (value = 1) => Response.json(result(value));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("Explore semantic request plan", () => {
  it("uses server row/column/grand contexts for pivot totals and does not sum derived values", () => {
    const config = { ...view(), viz: "pivot" as const, columns: [{ table: "region", column: "name" }], filters: [{ attribute: { table: "date", column: "year" }, op: "gte" as const, value: 2020 }], topN: { n: 5, measure: "sales" } };
    const plan = buildExploreRequests(config);
    expect(plan.query.limit).toBe(50_000);
    expect(plan.totals.map((item) => item.key)).toEqual(["rows", "columns", "grand"]);
    expect(plan.totals.map((item) => [item.query.rows, item.query.columns])).toEqual([[config.rows, []], [[], config.columns], [[], []]]);
    for (const total of plan.totals) {
      expect(total.query.measures).toEqual(config.values);
      expect(total.query.filters).toEqual(config.filters);
      expect(total.query.orderBy).toEqual([]);
      expect(total.query.topN).toBeUndefined();
    }
  });
  it("only requests totals when enabled and aggregates KPI values across all current filters", () => {
    expect(buildExploreRequests(view()).totals).toEqual([]);
    expect(buildExploreRequests({ ...view(), viz: "pivot", options: { ...view().options, showTotals: false } }).totals).toEqual([]);
    const kpi = buildExploreRequests({ ...view(), viz: "kpi", topN: { measure: "sales", n: 3 } }).query;
    expect(kpi.rows).toEqual([]);
    expect(kpi.columns).toEqual([]);
    expect(kpi.topN).toBeUndefined();
  });
});

describe("Explore debounced query controller", () => {
  const controllers: ExploreQueryController[] = [];
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }));
  afterEach(() => { controllers.forEach((controller) => controller.dispose()); controllers.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });
  function create(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    const controller = new ExploreQueryController("project", fetch);
    controllers.push(controller);
    return controller;
  }

  it("does not bind the native browser fetch receiver to the query controller", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) {
      receivers.push(this);
      if (this instanceof ExploreQueryController) throw new TypeError("Illegal invocation");
      return Promise.resolve(reply());
    });
    const controller = new ExploreQueryController("project");
    controllers.push(controller);
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(250);
    expect(receivers).toHaveLength(1);
    expect(receivers[0]).not.toBe(controller);
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(1);
    expect(controller.getSnapshot().error).toBeNull();
  });

  it("debounces all changes by 250ms and only sends the latest field selection", async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => reply());
    const controller = create(fetch);
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(200);
    controller.configure({ ...view(), values: ["profit"] });
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    const request = JSON.parse(fetch.mock.calls[0][1]?.body as string) as SemanticQuery;
    expect(request.measures).toEqual(["profit"]);
    expect(controller.getSnapshot().loading).toBe(false);
  });

  it("aborts a superseded request immediately and ignores stale successful responses", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const controller = create(async (_url, init) => { signals.push(init.signal as AbortSignal); return ++calls === 1 ? first.promise : second.promise; });
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(250);
    controller.configure({ ...view(), values: ["profit"] });
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    second.resolve(reply(9));
    await vi.advanceTimersByTimeAsync(0);
    first.resolve(reply(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(9);
    expect(controller.getSnapshot().resultConfig?.values).toEqual(["profit"]);
  });

  it("retains a previous result while showing elapsed time and cancels the active request", async () => {
    const next = deferred<Response>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    const controller = create(async (_url, init) => { signal = init.signal as AbortSignal; return ++calls === 1 ? reply(5) : next.promise; });
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(250);
    controller.retry();
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(5);
    expect(controller.getSnapshot().resultConfig?.rows).toEqual(view().rows);
    expect(controller.getSnapshot().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1_350);
    expect(controller.getSnapshot().slow).toBe(true);
    expect(controller.getSnapshot().elapsedMs).toBeGreaterThanOrEqual(1_000);
    controller.cancel();
    expect(signal?.aborted).toBe(true);
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(5);
    expect(controller.getSnapshot().error?.message).toContain("cancelled");
    expect(controller.getSnapshot().loading).toBe(false);
  });

  it("keeps error SQL and timing details available after a timeout", async () => {
    const controller = create(async () => Response.json({ error: "This query timed out. Try a smaller result.", sql: "SELECT compiled", params: [{ name: "limit", value: 100 }], timings: { totalMs: 30_000 } }, { status: 504 }));
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().error).toMatchObject({ status: 504, sql: "SELECT compiled", timings: { totalMs: 30_000 } });
    expect(controller.getSnapshot().loading).toBe(false);
  });

  it("retains the old result configuration when a changed measure fails", async () => {
    let calls = 0;
    const controller = create(async () => ++calls === 1 ? reply(7) : Response.json({ error: "Timeout" }, { status: 504 }));
    controller.configure(view());
    await vi.advanceTimersByTimeAsync(250);
    controller.configure({ ...view(), values: ["profit"], rows: [{ table: "region", column: "name" }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().resultConfig?.values).toEqual(["sales"]);
    expect(controller.getSnapshot().resultConfig?.rows).toEqual(view().rows);
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(7);
  });

  it.each(["rows", "columns", "none"] as const)("supplies correct server totals for a %s-only pivot and deduplicates equivalent contexts", async (axis) => {
    const config = { ...view(), viz: "pivot" as const, rows: axis === "rows" ? view().rows : [], columns: axis === "columns" ? [{ table: "date", column: "year" }] : [] };
    const queries: SemanticQuery[] = [];
    const controller = create(async (_url, init) => {
      const query = JSON.parse(init.body as string) as SemanticQuery;
      queries.push(query);
      const grouped = query.rows.length + (query.columns?.length ?? 0) > 0;
      return Response.json(grouped
        ? { ...result(), columns: [{ key: "a0", name: "Year", role: "attribute", type: "number" }, { key: "m0", name: "Sales", role: "measure", type: "number" }], rows: [{ a0: 2022, m0: 0.25 }] }
        : result(0.4));
    });
    controller.configure(config);
    await vi.advanceTimersByTimeAsync(250);
    const state = controller.getSnapshot();
    const pivot = buildPivot(state.result!, config, state.totals);
    expect(pivot.grandTotal).toEqual([0.4]);
    if (axis === "rows") {
      expect(pivot.rows[0].total).toEqual([0.25]);
      expect(pivot.columnTotals["[]"]).toEqual([0.4]);
    } else if (axis === "columns") {
      expect(pivot.rows[0].total).toEqual([0.4]);
      expect(pivot.columnTotals["[2022]"]).toEqual([0.25]);
    } else {
      expect(pivot.rows[0].total).toEqual([0.4]);
      expect(pivot.columnTotals["[]"]).toEqual([0.4]);
    }
    expect(queries).toHaveLength(axis === "none" ? 2 : 3);
    expect(state.loading).toBe(false);
  });

  it("cancels in-flight server totals as a group and never publishes superseded totals", async () => {
    const total = deferred<Response>();
    const signals: AbortSignal[] = [];
    const requests: SemanticQuery[] = [];
    const controller = create(async (_url, init) => {
      signals.push(init.signal as AbortSignal);
      requests.push(JSON.parse(init.body as string));
      return requests.length === 1 ? reply(4) : total.promise;
    });
    controller.configure({ ...view(), viz: "pivot", columns: [{ table: "region", column: "name" }] });
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(4);
    expect(controller.getSnapshot().loading).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(controller.getSnapshot().slow).toBe(true);
    controller.cancel();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    total.resolve(reply(999));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().totals).toEqual({});
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(4);
  });

  it("never replaces server totals with client sums when a total query fails", async () => {
    let calls = 0;
    const controller = create(async () => ++calls === 1 ? reply(0.5) : Response.json({ error: "Timeout" }, { status: 504 }));
    controller.configure({ ...view(), viz: "pivot" });
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().result?.rows[0].m0).toBe(0.5);
    expect(controller.getSnapshot().totals).toEqual({});
    expect(controller.getSnapshot().totalsError).toContain("em dash");
    expect(controller.getSnapshot().loading).toBe(false);
  });

  it("warns about truncated server totals and never displays partial totals", async () => {
    let calls = 0;
    const config = { ...view(), viz: "pivot" as const };
    const controller = create(async () => ++calls === 1 ? reply(0.5) : Response.json({ ...result(0.33), truncated: true }));
    controller.configure(config);
    await vi.advanceTimersByTimeAsync(250);
    const state = controller.getSnapshot();
    const pivot = buildPivot(state.result!, config, state.totals);
    expect(state.result?.rows[0].m0).toBe(0.5);
    expect(state.totals).toEqual({});
    expect(state.totalsError).toContain("result limit");
    expect(state.totalsError).toContain("em dash");
    expect(pivot.grandTotal).toEqual([null]);
    expect(pivot.rows[0].total).toEqual([null]);
    expect(state.loading).toBe(false);
  });
});
