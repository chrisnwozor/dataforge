import { buildExploreRequests, type ExploreTotals } from "@/components/explore/use-explore-query";
import type { ViewConfig } from "@/lib/explore/config";
import type { QueryFilter, QueryResult, SemanticQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { tileCacheKey } from "./cache";
import { applicableFilters, mergeDashboardFilters, resolveTileView, type DashboardSavedView } from "./filters";
import type { DashboardTile } from "./schema";

export interface DashboardTileQueryState {
  status: "idle" | "queued" | "loading" | "success" | "error";
  result?: QueryResult;
  totals?: ExploreTotals;
  /** Keep returned data paired with the exact view that produced it. */
  config?: ViewConfig;
  error?: string;
  totalsError?: string;
  elapsedMs: number;
  fromCache?: boolean;
  /** Identity of the returned result, useful before print/export of a new context. */
  modelVersion?: string;
  lastSuccessfulRunId?: string | null;
  refreshToken?: number;
}
export type DashboardTileStates = Record<string, DashboardTileQueryState>;
export interface DashboardQueryContext {
  projectId: string;
  model: SemanticModel | null;
  lastSuccessfulRunId: string | null;
  tiles: readonly DashboardTile[];
  views: readonly DashboardSavedView[];
  filters: readonly QueryFilter[];
  visibleIds: readonly string[];
  refreshToken?: number;
}
interface QueryBundle {
  result: QueryResult;
  totals: ExploreTotals;
  config: ViewConfig;
  totalsError?: string;
}
interface CacheEntry { value: QueryBundle; bytes: number; expires: number }

/** Responses are bounded independently of the server cache and invalidated by run/model keys. */
export class DashboardTileCache {
  private entries = new Map<string, CacheEntry>();
  private bytes = 0;
  constructor(private options: { maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number } = {}) {}
  get(key: string): QueryBundle | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= (this.options.now?.() ?? Date.now())) { this.delete(key); return; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: QueryBundle): void {
    this.delete(key);
    const bytes = (key.length + JSON.stringify(value).length) * 2;
    if (bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) return;
    this.entries.set(key, { value, bytes, expires: (this.options.now?.() ?? Date.now()) + (this.options.ttlMs ?? 300_000) });
    this.bytes += bytes;
    while (this.entries.size > (this.options.maxEntries ?? 64) || this.bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) this.delete(this.entries.keys().next().value!);
  }
  private delete(key: string): void { const entry = this.entries.get(key); if (entry) this.bytes -= entry.bytes; this.entries.delete(key); }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  get size(): number { return this.entries.size; }
}
export const dashboardTileCache = new DashboardTileCache();
export const clearDashboardTileCache = () => dashboardTileCache.clear();

type DashboardFetch = (url: string, init: RequestInit) => Promise<Response>;
interface TileSpec {
  tile: DashboardTile;
  key: string;
  config: ViewConfig;
  epoch: number;
  force: boolean;
  cacheable: boolean;
  modelVersion: string;
  lastSuccessfulRunId: string | null;
  refreshToken: number;
}
interface TileJob extends TileSpec {
  revision: number;
  enqueuedAt: number;
  controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  timedOut?: boolean;
}
const EMPTY_STATES: DashboardTileStates = {};
const messageFor = (error: unknown): string => error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? String(error.message) : "This tile could not be loaded. Try again.";

/** At most two pending tile loads feed the server scheduler; each tile settles independently. */
export class DashboardQueryController {
  private states: DashboardTileStates = EMPTY_STATES;
  private listeners = new Set<() => void>();
  private context: DashboardQueryContext | null = null;
  private specs = new Map<string, TileSpec>();
  private revisions = new Map<string, number>();
  private completed = new Map<string, { key: string; epoch: number }>();
  private blocked = new Map<string, string>();
  private queue: TileJob[] = [];
  private active = new Set<TileJob>();
  private debounce?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;
  private disposed = false;
  private refreshToken = 0;
  private epoch = 0;
  private readyAt = 0;

  constructor(private projectId: string, private fetchQuery: DashboardFetch = (url, init) => fetch(url, init), private cache = dashboardTileCache, private maxPending: 1 | 2 = 2) {}
  getSnapshot = (): DashboardTileStates => this.states;
  getServerSnapshot = (): DashboardTileStates => EMPTY_STATES;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(id: string, patch: Partial<DashboardTileQueryState>) {
    const previous = this.states[id] ?? { status: "idle" as const, elapsedMs: 0 };
    this.states = { ...this.states, [id]: { ...previous, ...patch } };
    for (const listener of this.listeners) listener();
  }
  private revision(id: string): number { return this.revisions.get(id) ?? 0; }
  private invalidate(id: string) {
    this.revisions.set(id, this.revision(id) + 1);
    this.queue = this.queue.filter((job) => job.tile.id !== id);
    for (const job of this.active) if (job.tile.id === id) job.controller.abort();
  }
  private current(job: TileJob): boolean {
    return !this.disposed && !job.controller.signal.aborted && this.revision(job.tile.id) === job.revision && this.specs.get(job.tile.id)?.key === job.key;
  }

  configure(context: DashboardQueryContext): void {
    if (context.projectId !== this.projectId) { this.dispose(); return; }
    this.disposed = false;
    this.context = context;
    const token = context.refreshToken ?? 0;
    const refreshed = token !== this.refreshToken;
    if (refreshed) { this.refreshToken = token; this.epoch++; }
    const visible = new Set(context.visibleIds);
    const ids = new Set(context.tiles.map((tile) => tile.id));
    for (const id of Object.keys(this.states)) if (!ids.has(id)) {
      this.invalidate(id); this.specs.delete(id); this.completed.delete(id); this.blocked.delete(id);
      const next = { ...this.states }; delete next[id]; this.states = next;
      for (const listener of this.listeners) listener();
    }
    let added = false;
    for (const tile of context.tiles) {
      if ((tile.type !== "chart" && tile.type !== "kpi") || !context.model) {
        this.invalidate(tile.id); this.specs.delete(tile.id);
        if (this.states[tile.id]?.status !== "idle") this.update(tile.id, { status: "idle", result: undefined, config: undefined, totals: undefined, error: undefined, elapsedMs: 0 });
        continue;
      }
      let config: ViewConfig;
      try {
        const view = resolveTileView(tile, context.views);
        if (!view) throw new Error("This saved Explore view is no longer available. Edit the tile to choose another view.");
        if (!view.values.length) throw new Error("Choose at least one measure for this tile.");
        config = {
          ...view,
          filters: mergeDashboardFilters(view.filters, applicableFilters(tile, context.model, context.filters, context.views)),
          options: { ...view.options, title: tile.title || view.options.title, numberFormat: tile.numberFormat, showLegend: tile.showLegend },
        };
      } catch (error) {
        this.invalidate(tile.id); this.specs.delete(tile.id);
        if (visible.has(tile.id) && (this.states[tile.id]?.status !== "error" || this.states[tile.id]?.error !== messageFor(error))) this.update(tile.id, { status: "error", error: messageFor(error), elapsedMs: 0 });
        continue;
      }
      const key = tileCacheKey({ projectId: context.projectId, modelVersion: context.model.version, lastSuccessfulRunId: context.lastSuccessfulRunId, tile, filters: config.filters, viewConfig: config });
      const prior = this.specs.get(tile.id);
      if (prior?.key !== key || refreshed) {
        this.invalidate(tile.id); this.blocked.delete(tile.id);
      }
      const completed = this.completed.get(tile.id);
      const spec: TileSpec = { tile, key, config, epoch: this.epoch, force: this.epoch > (completed?.epoch ?? 0), cacheable: Boolean(context.lastSuccessfulRunId), modelVersion: context.model.version, lastSuccessfulRunId: context.lastSuccessfulRunId, refreshToken: token };
      this.specs.set(tile.id, spec);
      if (!this.states[tile.id]) this.update(tile.id, { status: "idle", elapsedMs: 0 });
      if (!visible.has(tile.id)) {
        const pending = this.queue.some((job) => job.tile.id === tile.id) || [...this.active].some((job) => job.tile.id === tile.id && !job.controller.signal.aborted);
        if (pending) this.invalidate(tile.id);
        if (["queued", "loading"].includes(this.states[tile.id].status)) this.update(tile.id, { status: "idle", error: undefined, elapsedMs: 0 });
        continue;
      }
      if (this.blocked.get(tile.id) === key) continue;
      if (!refreshed && prior?.key === key && this.states[tile.id]?.status === "success" && completed?.key === key && completed.epoch === this.epoch) continue;
      if (this.queue.some((job) => job.tile.id === tile.id && job.key === key && job.epoch === this.epoch) || [...this.active].some((job) => job.tile.id === tile.id && this.current(job))) continue;
      if (!spec.force && spec.cacheable) {
        const cached = this.cache.get(key);
        if (cached) {
          this.completed.set(tile.id, { key, epoch: this.epoch });
          this.update(tile.id, { ...cached, status: "success", error: undefined, elapsedMs: 0, fromCache: true, modelVersion: spec.modelVersion, lastSuccessfulRunId: spec.lastSuccessfulRunId, refreshToken: spec.refreshToken });
          continue;
        }
      }
      this.enqueue(spec); added = true;
    }
    this.queue.sort((left, right) => this.position(left.tile.id) - this.position(right.tile.id));
    if (added) {
      clearTimeout(this.debounce);
      this.readyAt = performance.now() + 250;
      this.debounce = setTimeout(() => this.pump(), 250);
      this.ensureClock();
    }
  }
  private position(id: string): number {
    const ordered = [...(this.context?.tiles ?? [])].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
    return ordered.findIndex((tile) => tile.id === id);
  }
  private enqueue(spec: TileSpec) {
    this.queue.push({ ...spec, revision: this.revision(spec.tile.id), enqueuedAt: performance.now(), controller: new AbortController() });
    this.update(spec.tile.id, { status: "queued", error: undefined, totalsError: undefined, elapsedMs: 0 });
  }
  retry = (id: string): void => {
    const spec = this.specs.get(id);
    if (!spec || this.disposed) return;
    this.invalidate(id); this.blocked.delete(id);
    this.enqueue({ ...spec, force: true }); this.readyAt = performance.now(); this.ensureClock(); this.pump();
  };
  cancel = (id: string): void => {
    const spec = this.specs.get(id);
    this.invalidate(id);
    if (spec) this.blocked.set(id, spec.key);
    this.update(id, { status: "error", error: "Tile query cancelled. Retry when you are ready." });
    this.pump();
  };
  private ensureClock() {
    if (this.clock) return;
    this.clock = setInterval(() => {
      for (const job of [...this.queue, ...this.active]) if (this.current(job)) this.update(job.tile.id, { elapsedMs: performance.now() - job.enqueuedAt });
    }, 100);
  }
  private pump() {
    if (this.disposed) return;
    if (performance.now() < this.readyAt) {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.pump(), this.readyAt - performance.now());
      return;
    }
    while (this.active.size < this.maxPending && this.queue.length) {
      const job = this.queue.shift()!;
      if (!this.current(job)) continue;
      this.active.add(job);
      this.update(job.tile.id, { status: "loading", elapsedMs: performance.now() - job.enqueuedAt });
      job.timeout = setTimeout(() => {
        job.timedOut = true; job.controller.abort();
        if (!this.disposed && this.revision(job.tile.id) === job.revision) {
          this.blocked.set(job.tile.id, job.key);
          this.update(job.tile.id, { status: "error", error: "This tile exceeded its 30-second timeout. Narrow its filters or retry.", elapsedMs: performance.now() - job.enqueuedAt });
        }
      }, 30_000);
      void this.execute(job).finally(() => {
        clearTimeout(job.timeout); this.active.delete(job);
        if (!this.disposed) this.pump();
        if (!this.active.size && !this.queue.length) { clearInterval(this.clock); this.clock = undefined; }
      });
    }
    if (!this.active.size && !this.queue.length) { clearInterval(this.clock); this.clock = undefined; }
  }
  private async post(query: SemanticQuery, job: TileJob): Promise<QueryResult> {
    const signal = job.controller.signal;
    if (signal.aborted) throw new DOMException("The tile request was cancelled.", "AbortError");
    // A stuck fetch or response body must not retain a client work slot forever.
    // The server scheduler independently retains its physical lease until cleanup.
    return new Promise<QueryResult>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", abort); complete();
      };
      const abort = () => finish(() => reject(new DOMException("The tile request was cancelled.", "AbortError")));
      signal.addEventListener("abort", abort, { once: true });
      const operation = (async () => {
        const response = await this.fetchQuery(`/api/projects/${encodeURIComponent(this.projectId)}/query`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-DataForge-Query-Purpose": "dashboard" },
          body: JSON.stringify({ ...query, ...(job.force ? { cache: "bypass" } : {}) }), signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "This tile could not be loaded. Try again.");
        if (!body || !Array.isArray(body.rows) || !Array.isArray(body.columns)) throw new Error("The tile response was incomplete. Retry to load it again.");
        return body as QueryResult;
      })();
      operation.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
      if (signal.aborted) abort();
    });
  }
  private async execute(job: TileJob): Promise<void> {
    try {
      const plan = buildExploreRequests(job.config);
      const result = await this.post(plan.query, job);
      if (!this.current(job)) return;
      if (plan.totals.length) this.update(job.tile.id, { result, config: job.config, totals: {}, status: "loading", error: undefined, totalsError: undefined, fromCache: result.fromCache, modelVersion: job.modelVersion, lastSuccessfulRunId: job.lastSuccessfulRunId, refreshToken: job.refreshToken });
      const totals: ExploreTotals = {};
      const contexts = new Map<string, QueryResult>();
      let incomplete = false;
      // Sequential extra contexts keep even a pivot tile within its single client slot.
      for (const entry of plan.totals) {
        const key = JSON.stringify(entry.query);
        try {
          const total = contexts.get(key) ?? await this.post(entry.query, job);
          if (!this.current(job)) return;
          contexts.set(key, total);
          if (total.truncated) incomplete = true;
          else totals[entry.key] = total;
        } catch (error) {
          if (job.controller.signal.aborted) throw error;
          incomplete = true;
        }
      }
      const bundle: QueryBundle = { result, totals, config: job.config, totalsError: incomplete ? "Some server totals are unavailable or reached the result limit; incomplete totals show an em dash." : undefined };
      if (!this.current(job)) return;
      if (job.cacheable && !incomplete) this.cache.set(job.key, bundle);
      this.completed.set(job.tile.id, { key: job.key, epoch: job.epoch });
      this.update(job.tile.id, { ...bundle, status: "success", error: undefined, elapsedMs: result.elapsedMs, fromCache: result.fromCache, modelVersion: job.modelVersion, lastSuccessfulRunId: job.lastSuccessfulRunId, refreshToken: job.refreshToken });
    } catch (error) {
      if (this.disposed || this.revision(job.tile.id) !== job.revision || this.specs.get(job.tile.id)?.key !== job.key) return;
      this.blocked.set(job.tile.id, job.key);
      this.update(job.tile.id, { status: "error", error: job.timedOut ? "This tile exceeded its 30-second timeout. Narrow its filters or retry." : job.controller.signal.aborted ? "Tile query cancelled. Retry when you are ready." : messageFor(error), elapsedMs: performance.now() - job.enqueuedAt });
    }
  }
  dispose = (): void => {
    this.disposed = true; clearTimeout(this.debounce); clearInterval(this.clock); this.clock = undefined;
    for (const id of this.specs.keys()) this.invalidate(id);
    this.queue = [];
  };
}
