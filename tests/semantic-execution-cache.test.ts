import { describe, expect, it } from "vitest";
import {
  normalizedJson,
  ResultCache,
  resultCacheKey,
} from "@/lib/semantic/query/cache";

describe("semantic result LRU", () => {
  it("evicts least recently used entries and protects cached results from caller edits", () => {
    const cache = new ResultCache<{ rows: number[] }>(2, 1000);
    cache.set("a", { rows: [1] }, "one");
    cache.set("b", { rows: [2] }, "one");
    const first = cache.get("a")!;
    first.rows.push(99);
    cache.set("c", { rows: [3] }, "two");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual({ rows: [1] });
    expect(cache.size).toBe(2);
  });

  it("bounds UTF-8 key and value bytes and skips overlarge results", () => {
    const cache = new ResultCache<string>(200, 20);
    cache.set("one", "ééé", "one"); // 3 + 8 JSON bytes
    cache.set("two", "ééé", "two");
    expect(cache.get("one")).toBeUndefined();
    expect(cache.bytes).toBe(11);
    cache.set("x", "x".repeat(21), "three");
    expect(cache.size).toBe(1);
    cache.set("two", "a", "two");
    expect(cache.bytes).toBe(6);
    cache.clear();
    expect(cache.bytes).toBe(0);
  });

  it("invalidates only one project's results when run, semantic version or connection changes", () => {
    const cache = new ResultCache<number>();
    cache.useNamespace("one", "run1:model1:connection1");
    cache.set("a", 1, "one");
    cache.set("b", 2, "two");
    cache.useNamespace("one", "run1:model1:connection1");
    expect(cache.get("a")).toBe(1);
    cache.useNamespace("one", "run2:model1:connection1");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.set("c", 3, "one");
    cache.useNamespace("one", "run2:model2:connection1");
    expect(cache.get("c")).toBeUndefined();
    cache.set("d", 4, "one");
    cache.useNamespace("one", "run2:model2:connection2");
    expect(cache.get("d")).toBeUndefined();
    cache.invalidate("two");
    expect(cache.size).toBe(0);
  });

  it("normalizes object keys and includes project/run/model/connection/query in keys", () => {
    expect(normalizedJson({ b: 2, a: { y: [1, 2], x: true } })).toBe(
      normalizedJson({ a: { x: true, y: [1, 2] }, b: 2 }),
    );
    const base = resultCacheKey("p", "r", "v", { limit: 1000, rows: [] }, "c");
    expect(base).toBe(
      resultCacheKey("p", "r", "v", { rows: [], limit: 1000 }, "c"),
    );
    for (const key of [
      resultCacheKey("p2", "r", "v", { limit: 1000, rows: [] }, "c"),
      resultCacheKey("p", "r2", "v", { limit: 1000, rows: [] }, "c"),
      resultCacheKey("p", "r", "v2", { limit: 1000, rows: [] }, "c"),
      resultCacheKey("p", "r", "v", { limit: 1001, rows: [] }, "c"),
      resultCacheKey("p", "r", "v", { limit: 1000, rows: [] }, "c2"),
    ])
      expect(key).not.toBe(base);
  });
});
