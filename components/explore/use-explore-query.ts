"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { toSemanticQuery, type ViewConfig } from "@/lib/explore/config";
import type { QueryResult, QueryTimings, SemanticQuery } from "@/lib/semantic/query/types";
import type { SqlParameter } from "@/lib/semantic/types";

export interface ExploreTotals {
  rows?: QueryResult;
  columns?: QueryResult;
  grand?: QueryResult;
}
export interface ExploreQueryError {
  message: string;
  status?: number;
  sql?: string;
  params?: SqlParameter[];
  timings?: QueryTimings;
}
export interface ExploreQueryState {
  result: QueryResult | null;
  resultConfig: ViewConfig | null;
  totals: ExploreTotals;
  loading: boolean;
  slow: boolean;
  elapsedMs: number;
  error: ExploreQueryError | null;
  totalsError: string | null;
}

export interface ExploreRequestPlan {
  query: SemanticQuery;
  totals: { key: keyof ExploreTotals; query: SemanticQuery }[];
}

/** Totals are their own semantic queries: ratios, DISTINCTCOUNT and AVG cannot be added. */
export function buildExploreRequests(config: ViewConfig): ExploreRequestPlan {
  const query = toSemanticQuery(config);
  // A KPI is a value in the full filter context, never an arbitrary first grouped row.
  if (config.viz === "kpi") {
    query.rows = [];
    query.columns = [];
    query.orderBy = [];
    query.topN = undefined;
  }
  if (!config.options.showTotals || config.viz !== "pivot") return { query, totals: [] };
  const base = { ...query, topN: undefined, orderBy: [] };
  const totals: ExploreRequestPlan["totals"] = [
    { key: "rows", query: { ...base, rows: config.rows, columns: [] } },
    { key: "columns", query: { ...base, rows: [], columns: config.columns } },
    { key: "grand", query: { ...base, rows: [], columns: [] } },
  ];
  return { query, totals };
}

const initialState: ExploreQueryState = {
  result: null, resultConfig: null, totals: {}, loading: false, slow: false, elapsedMs: 0,
  error: null, totalsError: null,
};

type QueryFetch = (input: string, init: RequestInit) => Promise<Response>;

/** A small external store keeps timers/abort generations independent of React rendering. */
export class ExploreQueryController {
  private state: ExploreQueryState = initialState;
  private listeners = new Set<() => void>();
  private config: ViewConfig | null = null;
  private generation = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private clock?: ReturnType<typeof setInterval>;
  private controller?: AbortController;

  // Keep native browser fetch's receiver independent of the controller instance.
  constructor(private projectId: string, private fetchQuery: QueryFetch = (input, init) => fetch(input, init)) {}
  getSnapshot = (): ExploreQueryState => this.state;
  getServerSnapshot = (): ExploreQueryState => initialState;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<ExploreQueryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private stop() {
    clearTimeout(this.debounce);
    clearInterval(this.clock);
    this.controller?.abort();
    this.controller = undefined;
    this.generation++;
  }
  configure(config: ViewConfig | null) {
    this.stop();
    this.config = config;
    if (!config?.values.length) {
      this.update({ result: null, resultConfig: null, totals: {}, loading: false, slow: false, elapsedMs: 0, error: null, totalsError: null });
      return;
    }
    this.update({ loading: true, slow: false, elapsedMs: 0, error: null, totalsError: null });
    const generation = this.generation;
    this.debounce = setTimeout(() => void this.execute(config, generation), 250);
  }
  retry = () => this.configure(this.config);
  cancel = () => {
    this.stop();
    this.update({ loading: false, slow: false, error: { message: "Query cancelled. Change a field or retry when you are ready." } });
  };
  dispose = () => this.stop();

  private async post(query: SemanticQuery, signal: AbortSignal): Promise<QueryResult> {
    const response = await this.fetchQuery(`/api/projects/${encodeURIComponent(this.projectId)}/query`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query), signal,
    });
    const body = await response.json();
    if (!response.ok) {
      const failure: ExploreQueryError = {
        message: typeof body.error === "string" ? body.error : "The query could not be completed. Try again.",
        status: response.status, sql: body.sql, params: body.params, timings: body.timings,
      };
      throw failure;
    }
    return body as QueryResult;
  }
  private async execute(config: ViewConfig, generation: number) {
    if (generation !== this.generation) return;
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.clock = setInterval(() => {
      if (generation !== this.generation) return;
      const elapsedMs = performance.now() - started;
      this.update({ elapsedMs, slow: elapsedMs >= 1_000 });
    }, 100);
    const plan = buildExploreRequests(config);
    try {
      const result = await this.post(plan.query, controller.signal);
      if (generation !== this.generation || controller.signal.aborted) return;
      this.update({ result, resultConfig: config, totals: {}, loading: plan.totals.length > 0, error: null });
      if (plan.totals.length) {
        // Empty row/column axes share the same server context. Fetch it once and alias it.
        const contexts = new Map<string, Promise<QueryResult>>();
        const outcomes = await Promise.allSettled(plan.totals.map(async (entry) => {
          const key = JSON.stringify(entry.query);
          let pending = contexts.get(key);
          if (!pending) {
            pending = this.post(entry.query, controller.signal);
            contexts.set(key, pending);
          }
          return { key: entry.key, result: await pending };
        }));
        if (generation !== this.generation || controller.signal.aborted) return;
        const totals: ExploreTotals = {};
        let failed = false;
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled" && !outcome.value.result.truncated)
            totals[outcome.value.key] = outcome.value.result;
          else failed = true;
        }
        this.update({ totals, totalsError: failed ? "Some server totals are unavailable or reached the result limit. Incomplete totals are shown as an em dash; narrow the view or retry." : null });
      }
      this.update({ loading: false, slow: false, elapsedMs: result.elapsedMs });
    } catch (error) {
      if (generation !== this.generation || controller.signal.aborted) return;
      const failure = error instanceof TypeError
        ? { message: "The query could not reach DataForge. Check your connection and retry." }
        : error && typeof error === "object" && "message" in error
        ? error as ExploreQueryError
        : { message: "The query could not reach DataForge. Check your connection and retry." };
      this.update({ loading: false, slow: false, elapsedMs: performance.now() - started, error: failure });
    } finally {
      if (generation === this.generation) {
        clearInterval(this.clock);
        this.controller = undefined;
      }
    }
  }
}

export function useExploreQuery(projectId: string, config: ViewConfig | null) {
  const controller = useMemo(() => new ExploreQueryController(projectId), [projectId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => {
    controller.configure(config);
    return () => controller.dispose();
  }, [controller, config]);
  return { ...state, cancel: controller.cancel, retry: controller.retry };
}
