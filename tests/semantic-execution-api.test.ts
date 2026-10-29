import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticModel } from "@/lib/semantic/types";
import type { CompiledQuery } from "@/lib/semantic/query/types";
import type { QueryTimings } from "@/lib/semantic/query/types";
import { semanticCache } from "@/lib/semantic/query/cache";
import {
  getDistinctValues,
  runSemanticQuery,
} from "@/lib/server/semantic-query";
import { POST } from "@/app/api/projects/[id]/query/route";
import { GET as valuesGET } from "@/app/api/projects/[id]/query/values/route";

const state = vi.hoisted(() => ({
  ready: true,
  runId: "run-one",
  version: "version-one",
  connectionVersion: "connection-one",
  calls: [] as CompiledQuery[],
  rows: 1,
  failure: undefined as Error | undefined,
  changeInFlight: false,
  modelReads: 0,
  clock: undefined as number | undefined,
}));

const model: SemanticModel = {
  projectId: "11111111-1111-4111-8111-111111111111",
  version: "version-one",
  factTableId: "fact",
  tables: [
    {
      id: "fact",
      name: "fact_sales",
      schema: "dw",
      sqlName: "fact_sales",
      kind: "fact",
      keyColumnId: "fact:key",
      columns: [
        {
          id: "fact:key",
          tableId: "fact",
          name: "Sales Key",
          sqlName: "fact_sales_key",
          type: "number",
          role: "key",
        },
        {
          id: "fact:sales",
          tableId: "fact",
          name: "Sales",
          sqlName: "Sales",
          type: "number",
          role: "measure-source",
        },
        {
          id: "fact:region",
          tableId: "fact",
          name: "Region Key",
          sqlName: "RegionKey",
          type: "number",
          role: "key",
        },
      ],
    },
    {
      id: "region",
      name: "dim_region",
      schema: "dw",
      sqlName: "dim_region",
      kind: "dimension",
      keyColumnId: "region:key",
      columns: [
        {
          id: "region:key",
          tableId: "region",
          name: "Region Key",
          sqlName: "region_key",
          type: "number",
          role: "key",
        },
        {
          id: "region:name",
          tableId: "region",
          name: "Region",
          sqlName: "Region",
          type: "string",
          role: "attribute",
        },
      ],
    },
  ],
  relationships: [
    {
      id: "region-link",
      fromTableId: "fact",
      fromColumnId: "fact:region",
      toTableId: "region",
      toColumnId: "region:key",
      cardinality: "many-to-one",
    },
  ],
  measures: [
    {
      id: "sales",
      name: "Sales",
      expression: "SUM(fact_sales[Sales])",
      format: "currency",
      folder: "Sales",
      description: "",
      isAuto: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  hierarchies: [],
};

vi.mock("@/lib/server/semantic", async () => {
  const { HttpError } = await import("@/lib/server/http");
  return {
    requireSemanticReady: async () => {
      if (!state.ready)
        throw new HttpError(
          409,
          "Configure a connection and complete a successful load first.",
        );
      return {
        settings: {
          server: "localhost",
          database: "DataForge",
          password: "stored-password-do-not-expose",
        },
        run: { id: state.runId },
      };
    },
    getSemanticModel: async () => {
      state.modelReads++;
      return { ...model, version: state.version };
    },
    readSemanticStamp: () => state.version,
  };
});
vi.mock("@/lib/server/connection", () => ({
  readPublicConnection: () => ({ updatedAt: state.connectionVersion }),
  friendlyConnectionError: () => "The SQL Server connection failed safely.",
}));
vi.mock("@/lib/server/model-http", () => ({
  requireModelProject: async () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("@/lib/server/query-transport", () => ({
  QueryAbortedError: class QueryAbortedError extends Error {},
  executeCompiledQuery: async (
    _settings: unknown,
    compiled: CompiledQuery,
    _signal?: AbortSignal,
    report?: (timings: Partial<QueryTimings>) => void,
  ) => {
    state.calls.push(compiled);
    report?.({
      poolAcquireMs: 4,
      connectMs: 100,
      sendToFirstRowMs: 3000,
      fetchMs: 96,
      ...(compiled.diagnostics
        ? {
            sqlCompileMs: 978,
            sqlCompileCpuMs: 31,
            sqlExecuteMs: 39,
            sqlExecuteCpuMs: 8,
          }
        : {}),
    });
    if (state.clock !== undefined) state.clock += 3200;
    if (state.failure) throw state.failure;
    if (state.changeInFlight) state.version = "changed-while-query-ran";
    return Array.from({ length: state.rows }, (_, index) =>
      Object.fromEntries([
        ...compiled.columns.map((column) => [
          column.key,
          column.role === "measure" ? index + 10 : `Region ${index}`,
        ]),
        ["internal-secret-column", "not part of the compiler projection"],
      ]),
    );
  },
}));

const projectId = model.projectId;
const context = { params: Promise.resolve({ id: projectId }) };
const request = (body: unknown) =>
  new Request("http://localhost/api/projects/p/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  semanticCache.clear();
  state.ready = true;
  state.runId = "run-one";
  state.version = "version-one";
  state.connectionVersion = "connection-one";
  state.calls = [];
  state.rows = 1;
  state.failure = undefined;
  state.changeInFlight = false;
  state.modelReads = 0;
  state.clock = undefined;
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("semantic execution and query endpoints", () => {
  it("refreshes without reading or replacing a cached result and without diagnostics overhead", async () => {
    const input = { measures: ["sales"], rows: [] };
    await runSemanticQuery(projectId, input);
    const reads = vi.spyOn(semanticCache, "get");
    const writes = vi.spyOn(semanticCache, "set");
    const response = await POST(request({ ...input, cache: "bypass" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ fromCache: false });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(2);
    expect(state.calls.at(-1)?.diagnostics).not.toBe(true);
    expect((await runSemanticQuery(projectId, input)).fromCache).toBe(true);
    expect(state.calls).toHaveLength(2);
    expect((await POST(request({ ...input, cache: "arbitrary" }), context)).status).toBe(400);
  });

  it("routes dashboard slicers through the same POST compiler, queue and strict validation", async () => {
    const input = { kind: "values", attribute: { table: "region", column: "region:name" }, search: "50%_", limit: 20 };
    const response = await POST(request(input), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ columns: [{ key: "value" }, { key: "count" }] });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].limit).toBe(20);
    expect(state.calls[0].params.some((parameter) => String(parameter.value).includes("50~%~_"))).toBe(true);
    const refresh = await POST(request({ ...input, cache: "bypass" }), context);
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toMatchObject({ fromCache: false });
    expect(state.calls).toHaveLength(2);
    for (const bad of [{ ...input, sql: "SELECT 1" }, { ...input, limit: 201 }, { ...input, attribute: { table: "region", column: "missing" } }])
      expect((await POST(request(bad), context)).status).toBe(400);
    expect(state.calls).toHaveLength(2);
    const dashboardRequest = request({ measures: ["sales"], rows: [] });
    dashboardRequest.headers.set("X-DataForge-Query-Purpose", "dashboard");
    expect((await POST(dashboardRequest, context)).status).toBe(200);
  });

  it("runs diagnostics live without reading or replacing a normal cached result", async () => {
    const input = { measures: ["sales"], rows: [] };
    const ordinary = await runSemanticQuery(projectId, input);
    expect(ordinary.timings).not.toHaveProperty("sqlCompileMs");
    const diagnostic = await POST(
      request({ ...input, diagnostics: true }),
      context,
    );
    expect(diagnostic.status).toBe(200);
    expect(await diagnostic.json()).toMatchObject({
      fromCache: false,
      timings: { sqlCompileMs: 978, sqlCompileCpuMs: 31, sqlExecuteMs: 39 },
    });
    expect(state.calls.at(-1)?.diagnostics).toBe(true);
    expect(state.calls).toHaveLength(2);
    expect((await runSemanticQuery(projectId, input)).fromCache).toBe(true);
    await runSemanticQuery(projectId, { ...input, diagnostics: true });
    expect(state.calls).toHaveLength(3);
    expect(
      (await POST(request({ ...input, diagnostics: "true" }), context)).status,
    ).toBe(400);
  });
  it("reports this cache lookup's duration instead of the original SQL execution time", async () => {
    state.clock = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => state.clock!);
    const originalGet = semanticCache.get.bind(semanticCache);
    vi.spyOn(semanticCache, "get").mockImplementation((key) => {
      state.clock! += 0.25;
      return originalGet(key);
    });
    try {
      const first = await runSemanticQuery(projectId, {
        measures: ["sales"],
        rows: [],
      });
      expect(first.fromCache).toBe(false);
      expect(first.elapsedMs).toBe(3200.25);
      expect(first.timings).toMatchObject({
        cacheLookupMs: 0.25,
        connectMs: 100,
        poolAcquireMs: 4,
        sendToFirstRowMs: 3000,
        fetchMs: 96,
        totalMs: 3200.25,
      });
      expect(state.modelReads).toBe(1);
      const cached = await runSemanticQuery(projectId, {
        measures: ["sales"],
        rows: [],
      });
      expect(cached.fromCache).toBe(true);
      expect(cached.elapsedMs).toBe(0.25);
      expect(cached.timings).toMatchObject({
        cacheLookupMs: 0.25,
        connectMs: 0,
        poolAcquireMs: 0,
        sendToFirstRowMs: 0,
        fetchMs: 0,
        totalMs: 0.25,
      });
      expect(state.modelReads).toBe(2);
      expect(state.calls).toHaveLength(1);
      const logs = vi
        .mocked(console.info)
        .mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(logs[0].slowPhases).toContain("sendToFirstRowMs");
      expect(logs[1].fromCache).toBe(true);
      expect(JSON.stringify(logs)).not.toMatch(/stored-password|SELECT|Region/);
    } finally {
      clock.mockRestore();
    }
  });

  it("normalizes defaults, serves a cached result, and excludes non-projected driver fields", async () => {
    const first = await runSemanticQuery(projectId, {
      measures: ["sales"],
      rows: [],
    });
    expect(first.fromCache).toBe(false);
    expect(first.rowCount).toBe(1);
    expect(first.sql).toMatch(/SELECT/);
    expect(first.rows[0]).not.toHaveProperty("internal-secret-column");
    const second = await runSemanticQuery(projectId, {
      rows: [],
      measures: ["sales"],
      filters: [],
      orderBy: [],
      limit: 1000,
      hideUnknown: true,
    });
    expect(second.fromCache).toBe(true);
    expect(state.calls).toHaveLength(1);
    state.runId = "run-two";
    expect(
      (await runSemanticQuery(projectId, { measures: ["sales"], rows: [] }))
        .fromCache,
    ).toBe(false);
    state.version = "version-two";
    expect(
      (await runSemanticQuery(projectId, { measures: ["sales"], rows: [] }))
        .fromCache,
    ).toBe(false);
    state.connectionVersion = "connection-two";
    expect(
      (await runSemanticQuery(projectId, { measures: ["sales"], rows: [] }))
        .fromCache,
    ).toBe(false);
    expect(state.calls).toHaveLength(4);
  });

  it("truncates an extra fetched row and never caches a stale in-flight semantic snapshot", async () => {
    state.rows = 3;
    state.changeInFlight = true;
    const result = await runSemanticQuery(projectId, {
      measures: ["sales"],
      rows: [],
      limit: 2,
    });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(semanticCache.size).toBe(0);
  });

  it("requires a saved connection and a successful load for queries and slicers", async () => {
    state.ready = false;
    const response = await POST(
      request({ measures: ["sales"], rows: [] }),
      context,
    );
    expect(response.status).toBe(409);
    const values = await valuesGET(
      new Request("http://localhost/query/values?attribute=region%3Aname"),
      context,
    );
    expect(values.status).toBe(409);
    expect(state.calls).toHaveLength(0);
  });

  it("rejects arbitrary SQL, invalid references, oversized bodies and non-JSON requests", async () => {
    for (const body of [
      { sql: "DROP TABLE [dw].[fact_sales]" },
      { measures: ["sales"], rows: [], sql: "SELECT 1" },
      { measures: ["[x];DROP TABLE y;--"], rows: [] },
      { measures: ["sales"], rows: [{ table: "region", column: "x]--" }] },
    ])
      expect((await POST(request(body), context)).status).toBe(400);
    const tooLarge = request({
      measures: ["sales"],
      rows: [],
      ignored: "x".repeat(129 * 1024),
    });
    expect((await POST(tooLarge, context)).status).toBe(413);
    expect(
      (
        await POST(
          new Request("http://localhost/query", {
            method: "POST",
            body: "SELECT 1",
          }),
          context,
        )
      ).status,
    ).toBe(415);
    expect(state.calls).toHaveLength(0);
  });

  it("caches slicers, accepts JSON references and unique IDs, and validates query parameters", async () => {
    const attribute = { table: "region", column: "region:name" };
    const result = await getDistinctValues(
      projectId,
      JSON.stringify(attribute),
    );
    expect(result.columns.map((column) => column.key)).toEqual([
      "value",
      "count",
    ]);
    expect(
      (await getDistinctValues(projectId, JSON.stringify(attribute))).fromCache,
    ).toBe(true);
    expect((await getDistinctValues(projectId, "region:name")).rowCount).toBe(
      1,
    );
    expect(state.calls[0].limit).toBe(200);
    expect(state.calls[0].materialized).toBe(false);
    const searched = await valuesGET(new Request("http://localhost/values?attribute=region%3Aname&search=50%25_&limit=20"), context);
    expect(searched.status).toBe(200);
    expect(state.calls.at(-1)?.limit).toBe(20);
    expect(state.calls.at(-1)?.params.some((parameter) => String(parameter.value).includes("50~%~_"))).toBe(true);
    expect(state.calls.at(-1)?.sql).not.toContain("50%");
    for (const search of [
      "",
      "?attribute=region%3Aname&attribute=x",
      "?attribute=region%3Aname&hideUnknown=yes",
      "?attribute=region%3Aname&sql=SELECT%201",
      "?attribute=region%3Aname&limit=201",
      "?attribute=region%3Aname&limit=0",
      "?attribute=region%3Aname&limit=20&limit=30",
      "?attribute=region%3Aname&search=a&search=b",
      `?attribute=region%3Aname&search=${"x".repeat(201)}`,
    ])
      expect(
        (
          await valuesGET(
            new Request(`http://localhost/values${search}`),
            context,
          )
        ).status,
      ).toBe(400);
  });

  it("caps the simple pivot at 50 distinct column members without window SQL", async () => {
    state.rows = 60;
    const result = await runSemanticQuery(projectId, {
      measures: ["sales"], rows: [], columns: [{ table: "region", column: "region:name" }],
    });
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(50);
    expect(result.pivot?.columnValues).toHaveLength(50);
    expect(result.sql).not.toMatch(/DENSE_RANK|#df_/i);
  });

  it("returns actionable timeouts and schema drift while redacting secret-bearing errors", async () => {
    state.failure = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    expect(
      (await POST(request({ measures: ["sales"], rows: [] }), context)).status,
    ).toBe(504);
    state.failure = Object.assign(new Error("invalid column"), { number: 207 });
    expect(
      (await POST(request({ measures: ["sales"], rows: [] }), context)).status,
    ).toBe(409);
    state.failure = new Error("conversion: stored-password-do-not-expose");
    const response = await POST(
      request({ measures: ["sales"], rows: [] }),
      context,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(
      "stored-password-do-not-expose",
    );
  });

  it("does not read credentials or execute SQL for a cancelled query", async () => {
    await expect(
      runSemanticQuery(
        projectId,
        { measures: ["sales"], rows: [] },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({
      status: 499,
      message: "The query was cancelled.",
      queryTimings: expect.objectContaining({ connectMs: 0, poolAcquireMs: 0 }),
    });
    expect(state.calls).toHaveLength(0);
  });
});
