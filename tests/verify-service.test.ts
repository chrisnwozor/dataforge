import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as semanticStorage from "@/lib/server/semantic";
import { HttpError } from "@/lib/server/http";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { LOCAL_WORKSPACE_ID } from "@/lib/auth/migrations";
import { projectFixture } from "./helpers/auth";
import {
  startCheckRun,
  cancelCheckRun,
  waitForChecks,
  recoverVerificationRuns,
  buildVerificationPlan,
  type VerificationDependencies,
} from "@/lib/server/verification";
import {
  getVerificationRun,
  createVerificationRun,
  readCheckSettings,
} from "@/lib/server/verification-storage";
import { createProjectFromUpload } from "@/lib/server/uploads";
import {
  queryScheduler,
  QueryScheduler,
  queryServerKey,
} from "@/lib/server/query-scheduler";
import type { CheckOutcome } from "@/lib/verify/types";
let directory: string, projectId: string;
const pass: CheckOutcome = {
  status: "pass",
  expected: 12,
  actual: 12,
  difference: 0,
  tolerance: 0.01,
  explanation: "Independent calculation agrees.",
  nextStep: "No action needed.",
  sql: "SELECT independently",
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-check-service-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "off");
  vi.stubEnv("DATAFORGE_SECRET", "");
  projectId = projectFixture(LOCAL_WORKSPACE_ID);
});
afterEach(async () => {
  await waitForChecks(projectId).catch(() => {});
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
describe("durable Checks job lifecycle", () => {
  it("rejects profile edits during asynchronous model reads instead of protecting stale columns with a newer stamp", async () => {
    const run = createVerificationRun(projectId, {
      sourceRunId: null,
      modelVersion: null,
      trigger: "manual",
    });
    vi.spyOn(semanticStorage, "getSemanticModel").mockImplementationOnce(
      async () => {
        getDatabase()
          .prepare("UPDATE projects SET updated_at=?,row_count=? WHERE id=?")
          .run("2099-01-01T00:00:00.000Z", 99, projectId);
        throw new HttpError(409, "No SQL connection configured.");
      },
    );
    await expect(
      buildVerificationPlan(
        projectId,
        run,
        readCheckSettings(projectId),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/profile or model changed while check metadata/);
  });
  it("pins the source load before planning and rejects a load completed during metadata reads", async () => {
    const addLoad = (started: string) => {
      const id = randomUUID();
      getDatabase()
        .prepare(
          "INSERT INTO runs(id,project_id,status,mode,started_at,options_json,workspace_id) VALUES(?,?,'succeeded','full',?,?,?)",
        )
        .run(
          id,
          projectId,
          started,
          JSON.stringify({ db: "Warehouse", incremental: false, dedupe: true }),
          LOCAL_WORKSPACE_ID,
        );
      return id;
    };
    const first = addLoad("2025-01-01T00:00:00.000Z");
    const run = createVerificationRun(projectId, {
      sourceRunId: first,
      modelVersion: null,
      trigger: "manual",
    });
    const modelRead = vi
      .spyOn(semanticStorage, "getSemanticModel")
      .mockImplementationOnce(async () => {
        addLoad("2025-01-02T00:00:00.000Z");
        throw new HttpError(409, "No SQL connection configured.");
      });
    await expect(
      buildVerificationPlan(
        projectId,
        run,
        readCheckSettings(projectId),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/load changed while check metadata/);
    expect(modelRead).toHaveBeenCalledTimes(1);
    await expect(
      buildVerificationPlan(
        projectId,
        run,
        readCheckSettings(projectId),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/newer successful load/);
    expect(modelRead).toHaveBeenCalledTimes(1);
  });
  it("persists serial progress, SQL failures and partial numerical results without hiding them", async () => {
    const plan: VerificationDependencies = {
      plan: async () => ({
        checks: [
          {
            id: "pass",
            area: "Ingestion",
            name: "rows",
            run: async () => pass,
          },
          {
            id: "mismatch",
            area: "Semantic",
            name: "Sales",
            run: async () => ({
              ...pass,
              status: "fail",
              actual: 13,
              difference: 1,
            }),
          },
          {
            id: "driver",
            area: "Reports",
            name: "export",
            run: async () => {
              throw new Error("Driver failed");
            },
          },
        ],
      }),
    };
    const run = await startCheckRun(projectId, {}, plan);
    expect(run.status).toBe("queued");
    await waitForChecks(projectId);
    const detail = getVerificationRun(projectId, run.id);
    expect(detail).toMatchObject({
      status: "succeeded",
      completed: 3,
      total: 3,
      counts: { pass: 1, fail: 2, warn: 0, skipped: 0 },
    });
    expect(detail.results.map((r) => r.id)).toEqual([
      "pass",
      "mismatch",
      "driver",
    ]);
    expect(detail.results[2].explanation).toMatch(/Driver failed/);
    expect(
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS n FROM verification_results WHERE run_id=?",
        )
        .get(run.id)?.n,
    ).toBe(3);
  });
  it("enforces the active lock, passes abort through in-flight work, and preserves completed checks", async () => {
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const deps: VerificationDependencies = {
      plan: async () => ({
        checks: [
          {
            id: "first",
            area: "Ingestion",
            name: "first",
            run: async () => pass,
          },
          {
            id: "slow",
            area: "Semantic",
            name: "slow",
            run: async (signal) => {
              entered();
              await new Promise<void>((_r, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                }),
              );
              return pass;
            },
          },
        ],
      }),
    };
    const run = await startCheckRun(projectId, {}, deps);
    await started;
    await expect(startCheckRun(projectId, {}, deps)).rejects.toMatchObject({
      status: 409,
    });
    const cancelled = await cancelCheckRun(projectId, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completed).toBe(1);
    expect(cancelled.results.map((r) => r.id)).toEqual(["first"]);
  });
  it("stops on snapshot changes and leaves a clear failed run with prior results", async () => {
    let calls = 0;
    const run = await startCheckRun(
      projectId,
      {},
      {
        plan: async () => ({
          checks: [
            {
              id: "one",
              name: "one",
              area: "Ingestion",
              run: async () => pass,
            },
          ],
          snapshot: { version: 1 },
        }),
        assertSnapshot: () => {
          if (++calls > 1) throw new Error("A new load changed the snapshot");
        },
      },
    );
    await waitForChecks(projectId);
    expect(getVerificationRun(projectId, run.id)).toMatchObject({
      status: "failed",
      completed: 0,
      error: expect.stringContaining("snapshot"),
    });
  });
  it("recovers an orphaned owning-process record without deleting results", () => {
    const run = createVerificationRun(projectId, {
      sourceRunId: null,
      modelVersion: null,
      trigger: "manual",
    });
    recoverVerificationRuns(projectId);
    expect(getVerificationRun(projectId, run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("interrupted"),
    });
  });
  it("runs the real offline prepared/profile comparison and skips SQL explicitly", async () => {
    const body = new FormData();
    body.set("name", "Offline checks");
    body.set(
      "file",
      new File(
        [
          "Order ID,Sales,Order Date\n1,10.25,2024-01-01\n2,20.50,2024-01-02\n2,20.50,2024-01-02\n",
        ],
        "orders.csv",
        { type: "text/csv" },
      ),
    );
    const uploaded = await createProjectFromUpload(
      new Request("http://localhost/upload", { method: "POST", body }),
    );
    projectId = uploaded.project.id;
    const run = await startCheckRun(projectId);
    await waitForChecks(projectId);
    const actual = getVerificationRun(projectId, run.id);
    expect(actual.status, actual.error ?? "").toBe("succeeded");
    expect(
      actual.results.find((c) => c.id === "ingestion.prepared-profile"),
    ).toMatchObject({
      status: "pass",
      expected: { rows: 3, duplicates: 1, nullCells: 0 },
      actual: { rows: 3, duplicates: 1, nullCells: 0 },
    });
    expect(actual.results.filter((c) => c.status === "skipped")).toHaveLength(
      4,
    );
    expect(actual.results.filter((c) => c.status === "fail")).toEqual([]);
  });
});
describe("Checks scheduling uses the existing queue at lower priority", () => {
  it("runs interactive SQL before queued checks, with only one lease per project", async () => {
    const queue = new QueryScheduler();
    let release!: () => void;
    const held = new Promise<void>((r) => {
        release = r;
      }),
      events: string[] = [];
    const first = queue.schedule(
      { projectId: "p", serverKey: queryServerKey("server"), priority: "main" },
      async () => {
        events.push("main-start");
        await held;
        events.push("main-end");
      },
    );
    const checks = queue.schedule(
      {
        projectId: "p",
        serverKey: queryServerKey("server"),
        priority: "checks",
      },
      async () => {
        events.push("checks");
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["main-start"]);
    release();
    await first;
    await checks;
    expect(events).toEqual(["main-start", "main-end", "checks"]);
    await queue.close();
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0 });
  });
  it("keeps the shared scheduler bounded and exports the new low priority without replacing it", () => {
    expect(queryScheduler.snapshot()).toMatchObject({
      active: expect.any(Number),
      queued: expect.any(Number),
    });
    expect(readCheckSettings(projectId).autoAfterLoad).toBe(false);
  });
});
