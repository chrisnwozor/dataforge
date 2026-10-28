import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { HttpError } from "@/lib/server/http";
import {
  appendLog,
  createQueuedRun,
  getRunDetail,
  transitionRun,
} from "@/lib/server/runs";
import { GET as list, POST as start } from "@/app/api/projects/[id]/runs/route";
import { GET as detail } from "@/app/api/projects/[id]/runs/[runId]/route";
import { GET as events } from "@/app/api/projects/[id]/runs/[runId]/events/route";
import { POST as cancel } from "@/app/api/projects/[id]/runs/[runId]/cancel/route";

const engine = vi.hoisted(() => ({
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  recoverInterruptedRuns: vi.fn(),
}));
vi.mock("@/lib/runner", () => engine);
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-runs-api-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function project(): string {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  getDatabase()
    .prepare(
      "INSERT INTO projects (id, name, source_file, source_type, status, row_count, column_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, "Sales", "sales.csv", "CSV", "Ready", 2, 2, timestamp, timestamp);
  return id;
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const runContext = (id: string, runId: string) => ({
  params: Promise.resolve({ id, runId }),
});
const request = () => new Request("http://localhost/api/projects/id/runs");
const body = (value: unknown) =>
  new Request("http://localhost/api/projects/id/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
const options = { incremental: false, dedupe: true, db: "Warehouse" };
function emptyStreamPost(): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    duplex: "half",
  };
  return new Request("http://localhost/api/projects/id/runs", init);
}
describe("run APIs", () => {
  it("accepts actual empty POST streams without Content-Type for start and cancel", async () => {
    const id = project();
    const run = createQueuedRun(id, options, []);
    engine.startRun.mockResolvedValue(run);
    const request = emptyStreamPost();
    expect(request.body).not.toBeNull();
    expect(request.headers.has("content-type")).toBe(false);
    const started = await start(request, context(id));
    expect(started.status).toBe(202);
    expect(engine.startRun).toHaveBeenCalledWith(id, {});
    engine.cancelRun.mockImplementation(async () => {
      transitionRun(run.id, "cancelled");
      return getRunDetail(run.id);
    });
    expect(
      (await cancel(emptyStreamPost(), runContext(id, run.id))).status,
    ).toBe(200);
    expect(
      (await cancel(emptyStreamPost(), runContext(id, run.id))).status,
    ).toBe(409);
    expect(engine.cancelRun).toHaveBeenCalledTimes(1);
  });
  it("recovers interrupted runs before reading history, details, or the initial event snapshot", async () => {
    const id = project();
    for (const read of ["list", "detail", "events"] as const) {
      const run = createQueuedRun(id, options, []);
      engine.recoverInterruptedRuns.mockImplementation(() =>
        transitionRun(run.id, "failed", {
          errorMessage: "The previous process stopped.",
        }),
      );
      const response =
        read === "list"
          ? await list(request(), context(id))
          : read === "detail"
            ? await detail(request(), runContext(id, run.id))
            : await events(request(), runContext(id, run.id));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"status":"failed"');
      expect(getRunDetail(run.id)?.run.errorMessage).toBe(
        "The previous process stopped.",
      );
    }
    expect(engine.recoverInterruptedRuns).toHaveBeenCalledTimes(3);
  });
  it("starts with empty real history and returns202 immediately with the engine's new run", async () => {
    const id = project();
    expect(await (await list(request(), context(id))).json()).toEqual({
      runs: [],
    });
    const run = createQueuedRun(id, options, ["00_setup.sql"]);
    engine.startRun.mockResolvedValue(run);
    const response = await start(body(options), context(id));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: run.id, run });
    expect(engine.startRun).toHaveBeenCalledWith(id, options);
    expect(
      (await (await list(request(), context(id))).json()).runs,
    ).toHaveLength(1);
  });
  it("does not accept arbitrarySQL, unknownoptions, wrongpayloadtypes, or oversizedrequests", async () => {
    const id = project();
    for (const value of [
      { sql: "DROP TABLE anything" },
      { incremental: "true" },
      { db: "db", password: "secret" },
      { connectionUpdatedAt: "not-a-timestamp" },
    ])
      expect((await start(body(value), context(id))).status).toBe(400);
    expect(
      (
        await start(
          new Request("http://localhost", { method: "POST", body: "text" }),
          context(id),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await start(
          new Request("http://localhost", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: '{"incremental":',
          }),
          context(id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await start(
          new Request("http://localhost", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": "20000",
            },
            body: "{}",
          }),
          context(id),
        )
      ).status,
    ).toBe(413);
    expect(engine.startRun).not.toHaveBeenCalled();
  });
  it("validates project/run IDs and conceals runs belonging to other projects", async () => {
    const id = project();
    const other = project();
    const run = createQueuedRun(other, options, []);
    expect((await list(request(), context("not-a-uuid"))).status).toBe(400);
    expect((await list(request(), context(randomUUID()))).status).toBe(404);
    expect((await detail(request(), runContext(id, "invalid"))).status).toBe(
      400,
    );
    expect((await detail(request(), runContext(id, run.id))).status).toBe(404);
    expect((await events(request(), runContext(id, run.id))).status).toBe(404);
    expect(
      (
        await cancel(
          new Request("http://localhost", { method: "POST" }),
          runContext(id, run.id),
        )
      ).status,
    ).toBe(404);
    expect(engine.cancelRun).not.toHaveBeenCalled();
  });
  it("returns409 with the existing active run ID", async () => {
    const id = project();
    const run = createQueuedRun(id, options, []);
    engine.startRun.mockRejectedValue(
      new HttpError(409, "A run is already active for this project."),
    );
    const response = await start(body(options), context(id));
    expect(response.status).toBe(409);
    expect((await response.json()).activeRunId).toBe(run.id);
  });
  it("returns stored detail and delegates validated cancellation without acceptingSQL", async () => {
    const id = project();
    const run = createQueuedRun(id, options, ["00_setup.sql"]);
    appendLog(run.id, "INFO", "Queued");
    expect(
      await (await detail(request(), runContext(id, run.id))).json(),
    ).toEqual(getRunDetail(run.id));
    engine.cancelRun.mockImplementation(async () => {
      transitionRun(run.id, "cancelled");
      return getRunDetail(run.id);
    });
    const response = await cancel(
      new Request("http://localhost", { method: "POST" }),
      runContext(id, run.id),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).run.status).toBe("cancelled");
    expect(engine.cancelRun).toHaveBeenCalledWith(id, run.id);
    expect(
      (
        await cancel(
          new Request("http://localhost", { method: "POST" }),
          runContext(id, run.id),
        )
      ).status,
    ).toBe(409);
    expect(
      (await cancel(body({ sql: "anything" }), runContext(id, run.id))).status,
    ).toBe(400);
  });
  it("provides an SSEsnapshot thenchangedrunpayload and closes on terminalstate", async () => {
    vi.useFakeTimers();
    const id = project();
    const run = createQueuedRun(id, options, ["00_setup.sql"]);
    const response = await events(request(), runContext(id, run.id));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: snapshot",
    );
    appendLog(run.id, "INFO", "Started");
    transitionRun(run.id, "running");
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    const update = new TextDecoder().decode((await next).value);
    expect(update).toContain("event: run");
    expect(update).toContain('"status":"running"');
    expect(update).toContain("Started");
    transitionRun(run.id, "succeeded");
    const final = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    expect(new TextDecoder().decode((await final).value)).toContain(
      '"status":"succeeded"',
    );
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes terminal snapshots immediately and releases SSEtimers on cancellation", async () => {
    vi.useFakeTimers();
    const id = project();
    const run = createQueuedRun(id, options, []);
    const response = await events(request(), runContext(id, run.id));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    transitionRun(run.id, "cancelled");
    const done = await events(request(), runContext(id, run.id));
    expect(await done.text()).toContain('"status":"cancelled"');
    expect(vi.getTimerCount()).toBe(0);
    const nextProject = project();
    const nextRun = createQueuedRun(nextProject, options, []);
    const controller = new AbortController();
    const aborted = await events(
      new Request("http://localhost/events", { signal: controller.signal }),
      runContext(nextProject, nextRun.id),
    );
    const abortedReader = aborted.body!.getReader();
    await abortedReader.read();
    controller.abort();
    expect((await abortedReader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
