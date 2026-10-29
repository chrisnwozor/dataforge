import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardQueryController, DashboardTileCache, type DashboardQueryContext } from "@/lib/dashboards/query-controller";
import { createEmptyView, type ViewConfig } from "@/lib/explore/config";
import type { DashboardTile, KpiTile, ChartTile } from "@/lib/dashboards/schema";
import type { QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";

const model: SemanticModel = {
  projectId: "project", version: "model-one", factTableId: "fact", hierarchies: [],
  tables: [
    { id: "fact", name: "fact_sales", schema: "dw", sqlName: "fact_sales", kind: "fact", keyColumnId: "key", columns: [
      { id: "key", tableId: "fact", name: "Key", sqlName: "key", type: "number", role: "key" },
      { id: "sales", tableId: "fact", name: "Sales", sqlName: "sales", type: "number", role: "measure-source" },
      { id: "region_key", tableId: "fact", name: "Region key", sqlName: "region_key", type: "number", role: "key" },
    ] },
    { id: "region", name: "dim_region", schema: "dw", sqlName: "dim_region", kind: "dimension", keyColumnId: "region:key", columns: [
      { id: "region:key", tableId: "region", name: "Key", sqlName: "key", type: "number", role: "key" },
      { id: "region:name", tableId: "region", name: "Region", sqlName: "name", type: "string", role: "attribute", distinctCount: 4 },
    ] },
  ],
  relationships: [{ id: "region-link", fromTableId: "fact", fromColumnId: "region_key", toTableId: "region", toColumnId: "region:key", cardinality: "many-to-one" }],
  measures: ["sales", "profit", "yoy"].map((id) => ({ id, name: id, expression: "SUM(fact_sales[Sales])", format: "number", folder: "", description: "", isAuto: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" })),
};
const region = { table: "region", column: "region:name" };
const base = (id: string, x = 0, y = 0) => ({ id, x, y, w: 3, h: 2, title: id, subtitle: "", numberFormat: "auto" as const, showLegend: true });
const kpi = (id: string, x = 0, y = 0): KpiTile => ({ ...base(id, x, y), type: "kpi", measure: "sales" });
const view = (): ViewConfig => ({ ...createEmptyView(), viz: "bar", values: ["sales"], rows: [region] });
const chart = (id: string, config = view()): ChartTile => ({ ...base(id), type: "chart", source: { kind: "inline", config } });
const result = (value = 10): QueryResult => ({ columns: [{ key: "m0", name: "sales", role: "measure", type: "number" }], rows: [{ m0: value }], rowCount: 1, truncated: false, elapsedMs: 12, fromCache: false, sql: "SELECT generated_only" });
const response = (value = 10) => Response.json(result(value));
const context = (tiles: DashboardTile[] = [kpi("one")], patch: Partial<DashboardQueryContext> = {}): DashboardQueryContext => ({ projectId: "project", model, lastSuccessfulRunId: "run-one", tiles, views: [], filters: [], visibleIds: tiles.map((tile) => tile.id), asOfDate: "2025-08-10", ...patch });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const body = (init: RequestInit) => JSON.parse(init.body as string) as SemanticQuery & { cache?: string };
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };

describe("lazy dashboard query orchestration", () => {
  const controllers: DashboardQueryController[] = [];
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] }));
  afterEach(() => { controllers.forEach((controller) => controller.dispose()); controllers.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });
  function create(fetch: (url: string, init: RequestInit) => Promise<Response>, cache = new DashboardTileCache({ now: () => performance.now() }), maxPending: 1 | 2 = 2) { const controller = new DashboardQueryController("project", fetch, cache, maxPending); controllers.push(controller); return controller; }

  it("loads only visible data tiles and leaves text/slicers and unavailable models idle", async () => {
    const fetch = vi.fn(async () => response());
    const tiles: DashboardTile[] = [kpi("visible"), kpi("hidden", 3), { ...base("note"), type: "text", content: "Text" }, { ...base("slicer"), type: "slicer", attribute: region }];
    const controller = create(fetch);
    controller.configure(context(tiles, { visibleIds: ["visible", "note", "slicer"] }));
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().visible.status).toBe("success");
    expect(controller.getSnapshot().hidden.status).toBe("idle");
    expect(controller.getSnapshot().note.status).toBe("idle");
    expect(controller.getSnapshot().slicer.status).toBe("idle");
    controller.configure(context(tiles, { model: null }));
    await vi.advanceTimersByTimeAsync(500);
    expect(fetch).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().visible.status).toBe("idle");
  });

  it("starts at most two tile loads in visual order and advances without waiting for another tile", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const starts: string[] = [];
    const tiles = [kpi("bottom", 0, 4), kpi("right", 4, 0), kpi("left", 0, 0)].map((tile) => ({ ...tile, measure: tile.id }));
    const controller = create(async (_url, init) => { const measure = body(init).measures[0]; starts.push(measure); return measure === "left" ? first.promise : measure === "right" ? second.promise : response(3); });
    controller.configure(context(tiles));
    await vi.advanceTimersByTimeAsync(250);
    expect(starts).toEqual(["left", "right"]);
    expect(controller.getSnapshot().bottom.status).toBe("queued");
    second.resolve(response(2)); await flush();
    expect(starts).toEqual(["left", "right", "bottom"]);
    expect(controller.getSnapshot().left.status).toBe("loading");
    expect(controller.getSnapshot().bottom.status).toBe("success");
    first.resolve(response(1)); await flush();
  });

  it("isolates tile failures, advances the queue, and retries only the selected tile", async () => {
    let failed = true;
    const calls: string[] = [];
    const tiles = [kpi("bad"), kpi("good", 3), kpi("last", 6)].map((tile) => ({ ...tile, measure: tile.id }));
    const controller = create(async (_url, init) => { const measure = body(init).measures[0]; calls.push(measure); return measure === "bad" && failed ? Response.json({ error: "The selected measure was removed." }, { status: 400 }) : response(); });
    controller.configure(context(tiles)); await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().bad).toMatchObject({ status: "error", error: "The selected measure was removed." });
    expect(controller.getSnapshot().last.status).toBe("success");
    failed = false; controller.retry("bad"); await flush();
    expect(calls).toEqual(["bad", "good", "last", "bad"]);
    expect(controller.getSnapshot().bad.status).toBe("success");
  });

  it("aborts filter changes immediately, debounces the latest input, and rejects stale responses", async () => {
    const old = deferred<Response>();
    const requests: { query: ReturnType<typeof body>; signal: AbortSignal }[] = [];
    const controller = create(async (_url, init) => { requests.push({ query: body(init), signal: init.signal as AbortSignal }); return requests.length === 1 ? old.promise : response(20); });
    controller.configure(context()); await vi.advanceTimersByTimeAsync(250);
    controller.configure(context(undefined, { filters: [{ attribute: region, op: "eq", value: "East" }] }));
    expect(requests[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    controller.configure(context(undefined, { filters: [{ attribute: region, op: "eq", value: "West" }] }));
    old.resolve(response(999)); await flush();
    expect(controller.getSnapshot().one.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(249); expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].query.filters).toEqual([{ attribute: region, op: "eq", value: "West" }]);
    expect(controller.getSnapshot().one.result?.rows[0].m0).toBe(20);
  });

  it("releases cancelled client slots even when fetch ignores abort, without accepting late responses", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    let calls = 0;
    const controller = create(async () => { calls++; return calls === 1 ? a.promise : calls === 2 ? b.promise : response(); });
    const tiles = [kpi("one"), kpi("two", 3), kpi("three", 6)];
    controller.configure(context(tiles)); await vi.advanceTimersByTimeAsync(250);
    controller.configure(context(tiles, { filters: [{ attribute: region, op: "eq", value: "East" }] }));
    await vi.advanceTimersByTimeAsync(250); expect(calls).toBe(5);
    expect(controller.getSnapshot().one.status).toBe("success");
    b.resolve(response(999)); a.resolve(response(999)); await flush();
    expect(controller.getSnapshot().one.result?.rows[0].m0).toBe(10);
  });

  it("reuses tile cache across mounts but invalidates model versions and successful runs", async () => {
    const fetch = vi.fn(async () => response());
    const cache = new DashboardTileCache({ now: () => performance.now() });
    const first = create(fetch, cache); first.configure(context()); await vi.advanceTimersByTimeAsync(250); first.dispose();
    const second = create(fetch, cache); second.configure(context());
    expect(second.getSnapshot().one).toMatchObject({ status: "success", fromCache: true, elapsedMs: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    second.configure(context(undefined, { model: { ...model, version: "model-two" } })); await vi.advanceTimersByTimeAsync(250);
    second.configure(context(undefined, { model: { ...model, version: "model-two" }, lastSuccessfulRunId: "run-two" })); await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(second.getSnapshot().one).toMatchObject({ modelVersion: "model-two", lastSuccessfulRunId: "run-two", refreshToken: 0 });
  });

  it("layout edits reuse data while edited saved-view definitions issue the new measure query", async () => {
    const viewId = "11111111-1111-4111-8111-111111111111";
    const tile: ChartTile = { ...base("saved"), type: "chart", source: { kind: "view", viewId } };
    const requests: ReturnType<typeof body>[] = [];
    const controller = create(async (_url, init) => { requests.push(body(init)); return response(); });
    const start = context([tile], { views: [{ id: viewId, config: view() }] });
    controller.configure(start); await vi.advanceTimersByTimeAsync(250);
    controller.configure({ ...start, tiles: [{ ...tile, x: 4, w: 6, h: 4 }] }); await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(1);
    controller.configure({ ...start, views: [{ id: viewId, config: { ...view(), values: ["profit"] } }] }); await vi.advanceTimersByTimeAsync(250);
    expect(requests[1].measures).toEqual(["profit"]);
  });

  it("Refresh bypasses both caches, including a tile first scrolled into view afterward", async () => {
    const requests: { body: ReturnType<typeof body>; purpose: string | null }[] = [];
    const tiles = [kpi("one"), kpi("two", 3)];
    const controller = create(async (_url, init) => { requests.push({ body: body(init), purpose: new Headers(init.headers).get("X-DataForge-Query-Purpose") }); return response(); });
    controller.configure(context(tiles, { visibleIds: ["one"] })); await vi.advanceTimersByTimeAsync(250);
    controller.configure(context(tiles, { visibleIds: ["one"], refreshToken: 1 })); await vi.advanceTimersByTimeAsync(250);
    controller.configure(context(tiles, { visibleIds: ["one", "two"], refreshToken: 1 })); await vi.advanceTimersByTimeAsync(250);
    expect(requests.map((entry) => entry.body.cache)).toEqual([undefined, "bypass", "bypass"]);
    expect(requests.every((entry) => entry.purpose === "dashboard")).toBe(true);
    expect(requests.every((entry) => !("sql" in entry.body) && entry.body.diagnostics !== true)).toBe(true);
    expect(controller.getSnapshot().one.refreshToken).toBe(1);
    expect(controller.getSnapshot().two.refreshToken).toBe(1);
  });

  it("cancels queued and running tiles without automatically restarting them on a rerender", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const signals: AbortSignal[] = [];
    const controller = create(async (_url, init) => { signals.push(init.signal as AbortSignal); return signals.length === 1 ? first.promise : second.promise; });
    const ctx = context([kpi("one"), kpi("two", 3), kpi("three", 6)]);
    controller.configure(ctx); await vi.advanceTimersByTimeAsync(250);
    controller.cancel("three"); controller.cancel("one");
    expect(signals[0].aborted).toBe(true);
    controller.configure(ctx); await vi.advanceTimersByTimeAsync(500);
    expect(signals).toHaveLength(2);
    expect(controller.getSnapshot().three.status).toBe("error");
    first.resolve(response()); second.resolve(response()); await flush();
  });

  it("hides comparisons without a date dimension and keeps applicable dashboard filters on the main value", async () => {
    let sent: ReturnType<typeof body> | undefined;
    const controller = create(async (_url, init) => { sent = body(init); return response(); });
    controller.configure(context([{ ...kpi("one"), comparisonMeasure: "yoy" }], { filters: [{ attribute: region, op: "eq", value: "West" }] })); await vi.advanceTimersByTimeAsync(250);
    expect(sent).toMatchObject({ measures: ["sales"], rows: [], filters: [{ attribute: region, op: "eq", value: "West" }] });
    expect(controller.getSnapshot().one.kpi?.comparison).toBeUndefined();
  });

  const date = { table: "date", column: "date:date" };
  function datedModel(): SemanticModel {
    return { ...model, date: { tableId: "date", dateColumnId: "date:date", keyColumnId: "date:key", factColumnId: "date_key" }, tables: [...model.tables, {
      id: "date", name: "dim_date", schema: "dw", sqlName: "dim_date", kind: "dimension", keyColumnId: "date:key", columns: [
        { id: "date:key", tableId: "date", name: "Date Key", sqlName: "DateKey", type: "number", role: "key" },
        { id: "date:date", tableId: "date", name: "Date", sqlName: "Date", type: "date", role: "attribute" },
      ],
    }], relationships: [...model.relationships, { id: "date-link", fromTableId: "fact", fromColumnId: "date_key", toTableId: "date", toColumnId: "date:key", cardinality: "many-to-one" }], measures: model.measures.map((measure) => measure.id === "yoy" ? { ...measure, name: "Sales YoY %", expression: "DIVIDE([sales] - SAMEPERIODLASTYEAR([sales]), SAMEPERIODLASTYEAR([sales]))" } : measure) };
  }
  const latestResponse = () => Response.json({ ...result(), columns: [{ key: "a0", name: "Date", role: "attribute", type: "date" }], rows: [{ a0: "2025-08-10" }] });

  it("queries all-time Sales separately from the complete 2024 vs 2023 YoY comparison", async () => {
    const sent: SemanticQuery[] = [];
    const controller = create(async (_url, init) => {
      const query = body(init); sent.push(query);
      return query.rows.length ? latestResponse() : response(query.measures[0] === "yoy" ? 0.1253 : 712530);
    });
    const filters: SemanticQuery["filters"] = [{ attribute: region, op: "eq", value: "West" }, { attribute: date, op: "gte", value: "2023-01-01" }];
    controller.configure(context([{ ...kpi("one"), comparisonMeasure: "yoy" }], { model: datedModel(), filters }));
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toMatchObject({ rows: [date], limit: 1, orderBy: [{ ref: date, dir: "desc" }], filters: [filters[0], { attribute: date, op: "isNotNull" }] });
    expect(sent[1]).toMatchObject({ measures: ["sales"], rows: [], filters });
    expect(sent[2]).toMatchObject({ measures: ["yoy"], rows: [], filters: [filters[0], { attribute: date, op: "gte", value: "2024-01-01" }, { attribute: date, op: "lte", value: "2024-12-31" }] });
    expect(controller.getSnapshot().one).toMatchObject({ status: "success", result: { rows: [{ m0: 712530 }] }, kpi: { periodLabel: "All time", comparison: { label: "2024 vs 2023", measure: "yoy", result: { rows: [{ m0: 0.1253 }] } } } });
  });

  it.each([
    ["latestYear", "2024-01-01", "2024-12-31", "2024"],
    ["latestQuarter", "2025-04-01", "2025-06-30", "Q2 2025"],
    ["latestMonth", "2025-07-01", "2025-07-31", "Jul 2025"],
  ] as const)("scopes the main KPI to %s without changing a YoY comparison into a different interval", async (period, start, end, label) => {
    const sent: SemanticQuery[] = [];
    const controller = create(async (_url, init) => { const query = body(init); sent.push(query); return query.rows.length ? latestResponse() : response(); });
    controller.configure(context([{ ...kpi("one"), period, comparisonMeasure: "yoy" }], { model: datedModel() }));
    await vi.advanceTimersByTimeAsync(250);
    expect(sent[1].filters).toEqual([{ attribute: date, op: "gte", value: start }, { attribute: date, op: "lte", value: end }]);
    expect(controller.getSnapshot().one.kpi).toMatchObject({ periodLabel: label, comparison: { label: "2024 vs 2023" } });
  });

  it("reuses the fact-date watermark across visible KPIs but re-reads it after Refresh and new runs", async () => {
    let bounds = 0;
    const controller = create(async (_url, init) => { if (body(init).rows.length) { bounds++; return latestResponse(); } return response(); }, undefined, 1);
    const tiles = [kpi("one"), kpi("two", 3)].map((tile) => ({ ...tile, comparisonMeasure: "yoy" }));
    const start = context(tiles, { model: datedModel() });
    controller.configure(start); await vi.advanceTimersByTimeAsync(250);
    expect(bounds).toBe(1);
    controller.configure({ ...start, refreshToken: 1 }); await vi.advanceTimersByTimeAsync(250);
    expect(bounds).toBe(2);
    controller.configure({ ...start, refreshToken: 1, lastSuccessfulRunId: "new-run" }); await vi.advanceTimersByTimeAsync(250);
    expect(bounds).toBe(3);
  });

  it("cancels the period lookup and never sends a stale comparison after filters change", async () => {
    const first = deferred<Response>(); const sent: { query: SemanticQuery; signal: AbortSignal }[] = [];
    const controller = create(async (_url, init) => { const query = body(init); sent.push({ query, signal: init.signal as AbortSignal }); return sent.length === 1 ? first.promise : query.rows.length ? latestResponse() : response(); });
    const start = context([{ ...kpi("one"), comparisonMeasure: "yoy" }], { model: datedModel() });
    controller.configure(start); await vi.advanceTimersByTimeAsync(250);
    controller.configure({ ...start, filters: [{ attribute: region, op: "eq", value: "West" }] });
    expect(sent[0].signal.aborted).toBe(true);
    first.resolve(latestResponse()); await flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toHaveLength(4);
    expect(sent.slice(1).every(({ query }) => query.filters.some((filter) => filter.value === "West"))).toBe(true);
    expect(controller.getSnapshot().one.status).toBe("success");
  });

  it("queries and deduplicates pivot totals at server grains rather than summing ratios", async () => {
    const queries: ReturnType<typeof body>[] = [];
    const controller = create(async (_url, init) => { const query = body(init); queries.push(query); return response(query.rows.length ? 0.9 : 0.25); });
    controller.configure(context([chart("pivot", { ...view(), viz: "pivot" })])); await vi.advanceTimersByTimeAsync(250);
    expect(queries).toHaveLength(3);
    expect(controller.getSnapshot().pivot.result?.rows[0].m0).toBe(0.9);
    expect(controller.getSnapshot().pivot.totals?.grand?.rows[0].m0).toBe(0.25);
    expect(controller.getSnapshot().pivot.totals?.columns).toBe(controller.getSnapshot().pivot.totals?.grand);
  });

  it("keeps successful main results if a total fails and never caches an incomplete total bundle", async () => {
    let calls = 0;
    const cache = new DashboardTileCache({ now: () => performance.now() });
    const controller = create(async () => ++calls === 1 ? response(0.9) : Response.json({ error: "Timed out." }, { status: 504 }), cache);
    controller.configure(context([chart("pivot", { ...view(), viz: "pivot" })])); await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().pivot).toMatchObject({ status: "success", result: { rows: [{ m0: 0.9 }] }, totalsError: expect.stringMatching(/unavailable/) });
    expect(cache.size).toBe(0);
  });

  it("publishes pivot rows while a total is still loading and retains them if cancelled", async () => {
    const total = deferred<Response>();
    let calls = 0;
    const controller = create(async () => ++calls === 1 ? response(0.9) : total.promise);
    controller.configure(context([chart("pivot", { ...view(), viz: "pivot" })]));
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().pivot).toMatchObject({ status: "loading", result: { rows: [{ m0: 0.9 }] }, config: { viz: "pivot" }, totals: {} });
    controller.cancel("pivot"); await flush();
    expect(controller.getSnapshot().pivot).toMatchObject({ status: "error", result: { rows: [{ m0: 0.9 }] }, error: expect.stringMatching(/cancelled/) });
    total.resolve(response(999)); await flush();
    expect(controller.getSnapshot().pivot.totals).toEqual({});
  });

  it("a removed saved view produces its own friendly error without blocking a valid tile", async () => {
    const missing: ChartTile = { ...base("missing"), type: "chart", source: { kind: "view", viewId: "11111111-1111-4111-8111-111111111111" } };
    const fetch = vi.fn(async () => response());
    const controller = create(fetch); controller.configure(context([missing, kpi("one", 3)])); await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().missing.error).toMatch(/no longer available/);
    expect(controller.getSnapshot().one.status).toBe("success"); expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not mistake an invisible stale result for the new filter context when it reappears", async () => {
    const fetch = vi.fn(async () => response(fetch.mock.calls.length));
    const controller = create(fetch); controller.configure(context()); await vi.advanceTimersByTimeAsync(250);
    const filtered = context(undefined, { visibleIds: [], filters: [{ attribute: region, op: "eq", value: "East" }] });
    controller.configure(filtered); controller.configure({ ...filtered, visibleIds: ["one"] }); await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().one.config?.filters).toEqual(filtered.filters);
  });

  it("cancels hidden active and queued tiles so newly visible tiles can load first", async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const signals: AbortSignal[] = [];
    const cache = new DashboardTileCache({ now: () => performance.now() });
    const controller = create(async (_url, init) => {
      signals.push(init.signal as AbortSignal);
      return signals.length === 1 ? first.promise : signals.length === 2 ? second.promise : response(30);
    }, cache);
    const tiles = [kpi("one"), kpi("two", 3), kpi("queued", 6), kpi("visible", 0, 4)];
    controller.configure(context(tiles, { visibleIds: ["one", "two", "queued"] })); await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().queued.status).toBe("queued");
    controller.configure(context(tiles, { visibleIds: ["visible"] }));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(controller.getSnapshot().one.status).toBe("idle");
    expect(controller.getSnapshot().two.status).toBe("idle");
    expect(controller.getSnapshot().queued.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(250);
    expect(signals).toHaveLength(3);
    expect(controller.getSnapshot().visible.result?.rows[0].m0).toBe(30);
    first.resolve(response(999)); second.resolve(response(999)); await flush();
    expect(controller.getSnapshot().one.result).toBeUndefined(); expect(controller.getSnapshot().two.result).toBeUndefined(); expect(cache.size).toBe(1);
    controller.configure(context(tiles, { visibleIds: ["one"] })); await vi.advanceTimersByTimeAsync(250);
    expect(signals).toHaveLength(4); expect(controller.getSnapshot().one.status).toBe("success");
  });

  it("times out a slow tile and continues to the next queued tile", async () => {
    let calls = 0;
    const controller = create(async (_url, init) => {
      calls++;
      if (calls > 2) return response();
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    });
    controller.configure(context([kpi("one"), kpi("two", 3), kpi("three", 6)])); await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.getSnapshot().one.error).toMatch(/30-second timeout/);
    expect(controller.getSnapshot().three.status).toBe("success"); expect(calls).toBe(3);
  });

  it("the app's serial mode gives the next tile a fresh deadline after a slow tile times out", async () => {
    const slow = deferred<Response>(), next = deferred<Response>();
    const requests: { startedAt: number; signal: AbortSignal }[] = [];
    const controller = create(async (_url, init) => {
      requests.push({ startedAt: performance.now(), signal: init.signal as AbortSignal });
      return requests.length === 1 ? slow.promise : next.promise;
    }, new DashboardTileCache({ now: () => performance.now() }), 1);
    controller.configure(context([kpi("slow"), kpi("next", 3)]));
    await vi.advanceTimersByTimeAsync(250);
    expect(requests).toHaveLength(1);
    expect(controller.getSnapshot().next.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot().slow.error).toMatch(/30-second timeout/);
    expect(requests).toHaveLength(2);
    expect(requests[1].startedAt - requests[0].startedAt).toBe(30_000);
    expect(requests[1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests[1].signal.aborted).toBe(false);
    expect(controller.getSnapshot().next.status).toBe("loading");
    next.resolve(response(20)); await flush();
    expect(controller.getSnapshot().next.result?.rows[0].m0).toBe(20);
    slow.resolve(response(999)); await flush();
    expect(controller.getSnapshot().slow.result).toBeUndefined();
  });

  it("drains after two hung fetches time out even if neither fetch nor response.json honors abort", async () => {
    const fetchPending = deferred<Response>();
    const bodyPending = deferred<QueryResult>();
    let calls = 0;
    const cache = new DashboardTileCache({ now: () => performance.now() });
    const controller = create(async () => {
      calls++;
      if (calls === 1) return fetchPending.promise;
      if (calls === 2) return { ok: true, json: () => bodyPending.promise } as Response;
      return response(30);
    }, cache);
    controller.configure(context([kpi("one"), kpi("two", 3), kpi("three", 6)]));
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.getSnapshot().one.status).toBe("error");
    expect(controller.getSnapshot().two.status).toBe("error");
    expect(controller.getSnapshot().three.result?.rows[0].m0).toBe(30);
    fetchPending.resolve(response(999)); bodyPending.resolve(result(999)); await flush();
    expect(controller.getSnapshot().one.result).toBeUndefined();
    expect(controller.getSnapshot().two.result).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("calls native fetch without using the controller as its receiver", async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal("fetch", function (this: unknown) { receivers.push(this); if (this instanceof DashboardQueryController) throw new TypeError("Illegal invocation"); return Promise.resolve(response()); });
    const controller = new DashboardQueryController("project"); controllers.push(controller);
    controller.configure(context()); await vi.advanceTimersByTimeAsync(250);
    expect(receivers).toHaveLength(1); expect(receivers[0]).not.toBe(controller);
    expect(controller.getSnapshot().one.status).toBe("success");
  });
});

describe("bounded dashboard tile response cache", () => {
  const bundle = { result: result(), totals: {}, config: view() };
  it("evicts least-recently-used entries, expires results and avoids oversize entries", () => {
    let now = 0;
    const cache = new DashboardTileCache({ maxEntries: 2, maxBytes: 10_000, ttlMs: 1000, now: () => now });
    cache.set("one", bundle); cache.set("two", bundle); expect(cache.get("one")).toBe(bundle);
    cache.set("three", bundle); expect(cache.get("two")).toBeUndefined(); expect(cache.size).toBe(2);
    now = 1000; expect(cache.get("one")).toBeUndefined();
    cache.set("huge", { ...bundle, result: { ...result(), sql: "x".repeat(20_000) } }); expect(cache.get("huge")).toBeUndefined();
    cache.clear(); expect(cache.size).toBe(0);
  });
});
