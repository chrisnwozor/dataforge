import type { AttributeRef, QueryResult } from "@/lib/semantic/query/types";

export interface ExploreValuesOptions {
  version?: string;
  search?: string;
  signal?: AbortSignal;
  priority?: "values" | "prefetch";
  /** Dashboards use the unified query POST for every result, including slicers. */
  method?: "GET" | "POST";
  bypassCache?: boolean;
}
export interface ExploreValuesCandidate {
  ref: AttributeRef;
  distinctCount?: number;
}

const MAX_CACHE_ENTRIES = 64;
const CACHE_TTL_MS = 60_000;
const valuesCache = new Map<string, { expires: number; result: QueryResult }>();
const prefetchJobs = new Map<string, Promise<void>>();

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The values request was cancelled.", "AbortError");
}

/** Only completed responses are shared: aborting a slicer never aborts another caller. */
export async function loadExploreValues(
  projectId: string,
  attribute: AttributeRef,
  { version = "", search = "", signal, priority = "values", method = "GET", bypassCache = false }: ExploreValuesOptions = {},
): Promise<QueryResult> {
  checkAbort(signal);
  const term = search.trim().slice(0, 200);
  const key = JSON.stringify([projectId, version, attribute.table, attribute.column, term, method]);
  const cached = valuesCache.get(key);
  if (!bypassCache && cached && cached.expires > Date.now()) {
    valuesCache.delete(key);
    valuesCache.set(key, cached);
    return cached.result;
  }
  valuesCache.delete(key);
  const params = new URLSearchParams({ attribute: JSON.stringify(attribute), search: term, limit: "200" });
  const response = await fetch(method === "POST" ? `/api/projects/${encodeURIComponent(projectId)}/query` : `/api/projects/${encodeURIComponent(projectId)}/query/values?${params}`, {
    cache: "no-store",
    method,
    headers: { "X-DataForge-Query-Purpose": priority, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ kind: "values", attribute, search: term, limit: 200, hideUnknown: true, ...(bypassCache ? { cache: "bypass" } : {}) }) } : {}),
    signal,
  });
  const body = await response.json();
  checkAbort(signal);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Values could not be loaded. Try again.");
  if (!body || !Array.isArray(body.rows) || !Array.isArray(body.columns))
    throw new Error("The values response was incomplete. Try again.");
  const result = body as QueryResult;
  if (valuesCache.size >= MAX_CACHE_ENTRIES) valuesCache.delete(valuesCache.keys().next().value!);
  valuesCache.set(key, { expires: Date.now() + CACHE_TTL_MS, result });
  return result;
}

/** Unknown or large cardinalities are lazy. Background lookups run one at a time per project. */
export async function prefetchExploreValues(
  projectId: string,
  candidates: ExploreValuesCandidate[],
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const seen = new Set<string>();
  const attributes = candidates.filter(({ ref, distinctCount }) => {
    if (typeof distinctCount !== "number" || !Number.isInteger(distinctCount) || distinctCount < 0 || distinctCount > 500) return false;
    const key = JSON.stringify([ref.table, ref.column]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  if (!attributes.length) return;
  const preceding = prefetchJobs.get(projectId) ?? Promise.resolve();
  const job = preceding.catch(() => {}).then(async () => {
    for (const { ref } of attributes) {
      if (signal?.aborted) return;
      try {
        await loadExploreValues(projectId, ref, { version, signal, priority: "prefetch" });
      } catch {
        // Prefetch is optional; the open slicer can retry and show a useful error.
        if (signal?.aborted) return;
      }
    }
  });
  prefetchJobs.set(projectId, job);
  try {
    await job;
  } finally {
    if (prefetchJobs.get(projectId) === job) prefetchJobs.delete(projectId);
  }
}

/** Clear resolved client data when changing workspace or resetting an isolated check. */
export function clearExploreValuesCache(): void {
  valuesCache.clear();
}
