import type { QueryResult } from "./types";

interface CacheEntry<T> {
  value: T;
  bytes: number;
  projectId: string;
}

/** A byte-bounded LRU. JSON is also the API representation used for byte accounting. */
export class ResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly namespaces = new Map<string, string>();
  private usedBytes = 0;

  constructor(
    readonly maxEntries = 200,
    readonly maxBytes = 64 * 1024 * 1024,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxBytes < 1)
      throw new Error("Cache limits must be positive.");
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.usedBytes;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T, projectId: string): void {
    this.delete(key);
    const bytes = new TextEncoder().encode(
      key + JSON.stringify(value),
    ).byteLength;
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value: structuredClone(value), bytes, projectId });
    this.usedBytes += bytes;
    while (
      this.entries.size > this.maxEntries ||
      this.usedBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.usedBytes -= entry.bytes;
    this.entries.delete(key);
  }

  invalidate(projectId: string): void {
    for (const [key, entry] of this.entries)
      if (entry.projectId === projectId) this.delete(key);
    this.namespaces.delete(projectId);
  }

  /** Makes old runs/models/connections unservable, including after a process restart. */
  useNamespace(projectId: string, namespace: string): void {
    if (this.namespaces.get(projectId) !== namespace) {
      this.invalidate(projectId);
      this.namespaces.set(projectId, namespace);
      while (this.namespaces.size > this.maxEntries) {
        const oldest = this.namespaces.keys().next().value;
        if (oldest === undefined) break;
        this.invalidate(oldest);
      }
    } else {
      this.namespaces.delete(projectId);
      this.namespaces.set(projectId, namespace);
    }
  }

  clear(): void {
    this.entries.clear();
    this.namespaces.clear();
    this.usedBytes = 0;
  }
}

/** Stable object keys; array order is preserved because it controls result axes. */
export function normalizedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(normalizedJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${normalizedJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function resultCacheKey(
  projectId: string,
  runId: string,
  semanticVersion: string,
  query: unknown,
  connectionVersion = "",
): string {
  return normalizedJson({
    projectId,
    runId,
    semanticVersion,
    connectionVersion,
    query,
  });
}

const cacheGlobal = globalThis as typeof globalThis & {
  __dataforgeSemanticCache?: ResultCache<QueryResult>;
};
export const semanticCache = (cacheGlobal.__dataforgeSemanticCache ??=
  new ResultCache<QueryResult>());

export function invalidateSemanticCache(projectId: string): void {
  semanticCache.invalidate(projectId);
}
