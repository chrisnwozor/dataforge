import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearExploreValuesCache, loadExploreValues, prefetchExploreValues } from "@/lib/explore/values";
import type { AttributeRef, QueryResult } from "@/lib/semantic/query/types";

type ValuesFetch = (url: string, init: RequestInit) => Promise<Response>;
const ref = (column: string): AttributeRef => ({ table: "product", column });
const result = (value = "Furniture"): QueryResult => ({
  columns: [{ key: "value", name: "Category", role: "attribute", type: "string" }, { key: "count", name: "Count", role: "measure", type: "number" }],
  rows: [{ value, count: 10 }], rowCount: 1, elapsedMs: 1, fromCache: false, sql: "SELECT generated", truncated: false,
});
const response = (value?: string) => Response.json(result(value));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};

beforeEach(() => { clearExploreValuesCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); clearExploreValuesCache(); });

describe("Explore bounded slicer requests", () => {
  it("uses server-side search and TOP 200 with the caller's priority and signal", async () => {
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await loadExploreValues("project / one", ref("category"), { search: "  Fur%_  ", version: "one", signal: controller.signal });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname).toBe("/api/projects/project%20%2F%20one/query/values");
    expect(JSON.parse(parsed.searchParams.get("attribute")!)).toEqual(ref("category"));
    expect(parsed.searchParams.get("search")).toBe("Fur%_");
    expect(parsed.searchParams.get("limit")).toBe("200");
    expect(init).toMatchObject({ cache: "no-store", signal: controller.signal, headers: { "X-DataForge-Query-Purpose": "values" } });
  });

  it("keys completed cache entries by project, version, attribute and search", async () => {
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await loadExploreValues("p", ref("category"), { version: "v", search: "Furniture" });
    await loadExploreValues("p", ref("category"), { version: "v", search: " Furniture " });
    expect(fetch).toHaveBeenCalledTimes(1);
    await loadExploreValues("p", ref("category"), { version: "v", search: "Office" });
    await loadExploreValues("p", ref("product"), { version: "v", search: "Furniture" });
    await loadExploreValues("p", ref("category"), { version: "new", search: "Furniture" });
    await loadExploreValues("other", ref("category"), { version: "v", search: "Furniture" });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("expires completed data and bounds the cache to 64 entries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await loadExploreValues("p", ref("category"));
    vi.setSystemTime(Date.now() + 60_001);
    await loadExploreValues("p", ref("category"));
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 64; index++) await loadExploreValues("p", ref(`field${index}`));
    await loadExploreValues("p", ref("category"));
    expect(fetch).toHaveBeenCalledTimes(67);
  });

  it("does not cache a failed or aborted request and lets a later caller retry", async () => {
    const first = deferred<Response>();
    const fetch = vi.fn<ValuesFetch>().mockImplementationOnce(() => first.promise).mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = loadExploreValues("p", ref("category"), { signal: controller.signal });
    controller.abort();
    first.resolve(response("Stale"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await loadExploreValues("p", ref("category"))).rows[0].value).toBe("Furniture");
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValueOnce(Response.json({ error: "Friendly failure" }, { status: 504 }));
    await expect(loadExploreValues("p", ref("other"))).rejects.toThrow("Friendly failure");
    await loadExploreValues("p", ref("other"));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("does not share in-flight requests that have different cancellation owners", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetch = vi.fn<ValuesFetch>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const a = loadExploreValues("p", ref("category"), { signal: controller.signal });
    const b = loadExploreValues("p", ref("category"));
    controller.abort();
    first.resolve(response("Cancelled"));
    second.resolve(response("Current"));
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect((await b).rows[0].value).toBe("Current");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("skips work for an already-aborted caller, including a cached response", async () => {
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await loadExploreValues("p", ref("category"));
    await expect(loadExploreValues("p", ref("category"), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Explore low-cardinality prefetch", () => {
  it("never requests unknown, high-cardinality or invalid attributes", async () => {
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await prefetchExploreValues("p", [
      { ref: ref("Order ID"), distinctCount: 2_000 },
      { ref: ref("Date"), distinctCount: 700 },
      { ref: ref("unknown") },
      { ref: ref("nan"), distinctCount: Number.NaN },
      { ref: ref("negative"), distinctCount: -1 },
      { ref: ref("fraction"), distinctCount: 1.5 },
    ], "v");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs at most one lookup at a time and marks the request as prefetch", async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const fetch = vi.fn<ValuesFetch>().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    vi.stubGlobal("fetch", fetch);
    const pending = prefetchExploreValues("serial", [{ ref: ref("category"), distinctCount: 3 }, { ref: ref("product"), distinctCount: 500 }], "v");
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers).toEqual({ "X-DataForge-Query-Purpose": "prefetch" });
    a.resolve(response());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    b.resolve(response());
    await pending;
  });

  it("serializes overlapping prefetch batches for the same project and deduplicates candidates", async () => {
    const first = deferred<Response>();
    const fetch = vi.fn<ValuesFetch>().mockImplementationOnce(() => first.promise).mockImplementation(async () => response());
    vi.stubGlobal("fetch", fetch);
    const a = prefetchExploreValues("overlap", [{ ref: ref("category"), distinctCount: 3 }, { ref: ref("category"), distinctCount: 3 }], "v");
    const b = prefetchExploreValues("overlap", [{ ref: ref("product"), distinctCount: 5 }], "v");
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    first.resolve(response());
    await Promise.all([a, b]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts before requesting the next attribute when a newer main query starts", async () => {
    const first = deferred<Response>();
    const fetch = vi.fn<ValuesFetch>(() => first.promise);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = prefetchExploreValues("cancel", [{ ref: ref("category"), distinctCount: 3 }, { ref: ref("product"), distinctCount: 5 }], "v", controller.signal);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    first.resolve(response());
    await pending;
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("prefetches only the first three distinct eligible candidates and reuses completed data on open", async () => {
    const fetch = vi.fn<ValuesFetch>(async () => response());
    vi.stubGlobal("fetch", fetch);
    await prefetchExploreValues("bounded", Array.from({ length: 8 }, (_, index) => ({ ref: ref(`f${index}`), distinctCount: 2 })), "v");
    expect(fetch).toHaveBeenCalledTimes(3);
    await loadExploreValues("bounded", ref("f0"), { version: "v" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
