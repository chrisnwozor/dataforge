import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompiledQuery } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { POST } from "@/app/api/projects/[id]/query/route";
import { semanticCache } from "@/lib/semantic/query/cache";
import { createSuperstoreSemanticFixture } from "./fixtures/superstore-semantic";

const state = vi.hoisted(() => ({
  model: undefined as SemanticModel | undefined,
  calls: [] as CompiledQuery[],
  rows: 2,
  ready: true,
  failure: undefined as Error | undefined,
  signal: undefined as AbortSignal | undefined,
}));
vi.mock("@/lib/server/model-http", () => ({ requireModelProject: async () => "11111111-1111-4111-8111-111111111111" }));
vi.mock("@/lib/server/semantic", async () => {
  const { HttpError } = await import("@/lib/server/http");
  return {
    requireSemanticReady: async () => {
      if (!state.ready) throw new HttpError(409, "Configure a connection and complete a successful load first.");
      return { settings: { server: "localhost", database: "DataForge", password: "secret-not-for-export" }, run: { id: "run-one" } };
    },
    getSemanticModel: async () => state.model!,
    readSemanticStamp: () => "version-one",
  };
});
vi.mock("@/lib/server/connection", () => ({ readPublicConnection: () => ({ updatedAt: "connection-one" }), friendlyConnectionError: () => "Connection failed." }));
vi.mock("@/lib/server/query-transport", () => ({
  QueryAbortedError: class QueryAbortedError extends Error {},
  executeCompiledQuery: async (_settings: unknown, compiled: CompiledQuery, signal?: AbortSignal) => {
    state.calls.push(compiled);
    state.signal = signal;
    if (state.failure) throw state.failure;
    return Array.from({ length: state.rows }, (_, index) => Object.fromEntries(compiled.columns.map((column) => [
      column.key,
      column.role === "measure" ? index === 0 ? -12.5 : 20 : index === 0 ? '=SUM(1,2)\n"unsafe"' : "Furniture, chairs",
    ])));
  },
}));
const context = { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) };
const query = () => ({ measures: ["Sales"], rows: [{ table: "dim_product", column: "Category" }], limit: 10 });
const request = (body: unknown, accept = "text/csv", signal?: AbortSignal) => new Request("http://localhost/api/projects/p/query", {
  method: "POST", headers: { "Content-Type": "application/json", Accept: accept }, body: JSON.stringify(body), signal,
});
beforeAll(async () => { state.model = await createSuperstoreSemanticFixture(); });
beforeEach(() => {
  state.calls = [];
  state.rows = 2;
  state.ready = true;
  state.failure = undefined;
  state.signal = undefined;
  semanticCache.clear();
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Explore CSV through the semantic query API", () => {
  it("exports escaped long results through the same parameterized compiler and driver, raising the limit to 50,000", async () => {
    const controller = new AbortController();
    const response = await POST(request(query(), "text/csv", controller.signal), context);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("dataforge-explore.csv");
    expect(response.headers.get("x-dataforge-truncated")).toBe("false");
    expect(response.headers.get("x-dataforge-row-count")).toBe("2");
    const text = await response.text();
    expect(text).toContain('Category,Sales\r\n');
    expect(text).toContain('"\'=SUM(1,2)\n""unsafe""",-12.5\r\n');
    expect(text).toContain('"Furniture, chairs",20\r\n');
    expect(text).not.toContain("secret-not-for-export");
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].limit).toBe(50_000);
    expect(state.calls[0].params.some((parameter) => parameter.name === "__df_limit" && parameter.type === "number")).toBe(true);
    expect(state.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(state.signal?.aborted).toBe(true);
  });

  it("caps results and exposes an explicit truncation warning header", async () => {
    state.rows = 50_001;
    const response = await POST(request(query()), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-dataforge-truncated")).toBe("true");
    expect(response.headers.get("x-dataforge-row-count")).toBe("50000");
    const text = await response.text();
    expect(text.match(/Furniture, chairs/g)).toHaveLength(49_999);
  });

  it("strictly validates export input before compilation, including the original requested cap", async () => {
    for (const body of [
      { ...query(), sql: "SELECT * FROM private_table" },
      { ...query(), limit: 50_001 },
      { ...query(), topN: { measure: "Sales", n: 50_001 } },
      { ...query(), measures: [] },
    ]) expect((await POST(request(body), context)).status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it("retains top N and filters and never adds a second SQL execution path", async () => {
    const input = { ...query(), topN: { measure: "Sales", n: 7 }, filters: [{ attribute: { table: "dim_product", column: "Category" }, op: "eq", value: "Furniture" }] };
    const exported = await POST(request(input), context);
    expect(exported.status, await exported.clone().text()).toBe(200);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].params.some((parameter) => parameter.value === "Furniture")).toBe(true);
    expect(state.calls[0].limit).toBe(7);
    expect(state.calls[0].sql).not.toContain("'Furniture'");
  });

  it("keeps JSON query responses unchanged and respects an excluded CSV media type", async () => {
    for (const accept of ["application/json", "text/csv;q=0, application/json"]) {
      semanticCache.clear();
      const response = await POST(request(query(), accept), context);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ rowCount: 2, truncated: false });
      expect(state.calls.at(-1)?.limit).toBe(10);
    }
  });

  it("returns friendly JSON errors for readiness and timeout failures instead of malformed CSV", async () => {
    state.ready = false;
    const unavailable = await POST(request(query()), context);
    expect(unavailable.status).toBe(409);
    expect(unavailable.headers.get("content-type")).toContain("application/json");
    expect(await unavailable.text()).toMatch(/successful load/);
    state.ready = true;
    state.failure = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const timeout = await POST(request(query()), context);
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({ error: expect.stringMatching(/timeout/i), sql: expect.any(String), timings: expect.any(Object) });
  });
});
