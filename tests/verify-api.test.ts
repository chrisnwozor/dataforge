import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase } from "@/lib/server/db";
import { LOCAL_WORKSPACE_ID } from "@/lib/auth/migrations";
import {
  asUser,
  authRequest,
  memberFixture,
  projectFixture,
  userFixture,
  workspaceFixture,
} from "./helpers/auth";
import {
  appendVerificationResult,
  createVerificationRun,
  getVerificationRun,
  updateVerificationRun,
} from "@/lib/server/verification-storage";
import type { CheckResult } from "@/lib/verify/types";

const calls = vi.hoisted(() => ({ starts: 0, cancels: 0 }));
vi.mock("@/lib/server/verification", async () => {
  const storage = await import("@/lib/server/verification-storage");
  return {
    startCheckRun: vi.fn(async (projectId: string) => {
      calls.starts++;
      return storage.createVerificationRun(projectId, {
        sourceRunId: null,
        modelVersion: "model-v1",
        trigger: "manual",
      });
    }),
    cancelCheckRun: vi.fn(async (projectId: string, runId: string) => {
      calls.cancels++;
      return storage.updateVerificationRun(projectId, runId, {
        status: "cancelled",
      });
    }),
    recoverVerificationRuns: vi.fn(),
    verificationSnapshotInfo: async () => ({
      latestSourceRunId: null,
      modelVersion: "model-v1",
    }),
  };
});
import {
  GET as history,
  POST as start,
} from "@/app/api/projects/[id]/checks/route";
import { GET as detail } from "@/app/api/projects/[id]/checks/[runId]/route";
import { POST as cancel } from "@/app/api/projects/[id]/checks/[runId]/cancel/route";
import { PUT as settings } from "@/app/api/projects/[id]/checks/settings/route";
import { GET as download } from "@/app/api/projects/[id]/checks/[runId]/download/route";
let directory: string, projectId: string;
const context = (id: string = projectId, runId: string = randomUUID()) => ({
  params: Promise.resolve({ id, runId }),
});
const request = (
  method = "GET",
  body?: unknown,
  contentType = "application/json",
) =>
  new Request("http://localhost/api/projects/project/checks", {
    method,
    headers: { "Content-Type": contentType },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const check: CheckResult = {
  id: "rows",
  area: "Ingestion",
  name: "Source rows",
  status: "fail",
  expected: 2003,
  actual: 2000,
  difference: -3,
  tolerance: 0,
  elapsedMs: 5,
  explanation: "Three rows differ from the independent source reference.",
  nextStep:
    "Inspect the input fixture; do not change its values to hide a mismatch.",
  sql: "SELECT COUNT_BIG(*) AS [rows] FROM [stg].[orders]",
  referenceSql: "Streaming CSV count",
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-verification-api-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "off");
  projectId = projectFixture(LOCAL_WORKSPACE_ID);
  calls.starts = 0;
  calls.cancels = 0;
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("project Checks endpoints with a runner double", () => {
  it("returns an empty history/default settings, starts immediately, and serves compact history plus full details", async () => {
    const first = await history(request(), context());
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await first.json()).toMatchObject({
      runs: [],
      activeRunId: null,
      settings: { version: 1, autoAfterLoad: false },
      latestSourceRunId: null,
      modelVersion: "model-v1",
    });
    const created = await start(request("POST", {}), context());
    expect(created.status).toBe(202);
    const { run } = await created.json();
    expect(run.status).toBe("queued");
    expect(calls.starts).toBe(1);
    updateVerificationRun(projectId, run.id, { status: "running", total: 1 });
    appendVerificationResult(projectId, run.id, check);
    updateVerificationRun(projectId, run.id, { status: "succeeded" });
    const listed = await (await history(request(), context())).json();
    expect(listed.runs[0].results).toEqual([]);
    expect(listed.runs[0].counts.fail).toBe(1);
    expect(listed.activeRunId).toBeNull();
    const opened = await detail(request(), context(projectId, run.id));
    expect(opened.status).toBe(200);
    expect((await opened.json()).run.results).toEqual([check]);
  });
  it("rejects arbitrary SQL/query/path inputs and oversized or malformed start bodies before invoking the runner", async () => {
    for (const body of [
      { sql: "SELECT passwords" },
      { query: {} },
      { path: "../../dataforge.db" },
      { sourceRunId: randomUUID() },
      null,
      [],
    ])
      expect((await start(request("POST", body), context())).status).toBe(400);
    expect(
      (await start(request("POST", {}, "text/plain"), context())).status,
    ).toBe(415);
    expect(
      (
        await start(
          new Request("http://localhost/checks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{",
          }),
          context(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await start(
          new Request("http://localhost/checks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: `{"x":"${"x".repeat(17000)}"}`,
          }),
          context(),
        )
      ).status,
    ).toBe(413);
    expect(calls.starts).toBe(0);
  });
  it("honors the durable one-active-run lock and cancels a run without erasing its recorded failures", async () => {
    const response = await start(request("POST"), context());
    const { run } = await response.json();
    expect((await start(request("POST"), context())).status).toBe(409);
    updateVerificationRun(projectId, run.id, { total: 1 });
    appendVerificationResult(projectId, run.id, check);
    const cancelled = await cancel(request("POST"), context(projectId, run.id));
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).run.status).toBe("cancelled");
    expect(getVerificationRun(projectId, run.id).results).toEqual([check]);
    expect(calls.cancels).toBe(1);
  });
  it("validates and persists versioned auto-run/tolerance settings", async () => {
    const input = {
      version: 1,
      autoAfterLoad: true,
      absoluteTolerance: 0.005,
      relativeTolerance: 0.00001,
    };
    const saved = await settings(request("PUT", input), context());
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ settings: input });
    for (const body of [
      { version: 2 },
      { version: 1, autoAfterLoad: "true" },
      { version: 1, absoluteTolerance: -1 },
      { version: 1, sql: "DROP TABLE" },
    ])
      expect((await settings(request("PUT", body), context())).status).toBe(
        400,
      );
    expect(
      (await settings(request("PUT", input, "text/plain"), context())).status,
    ).toBe(415);
    expect(
      (await (await history(request(), context())).json()).settings,
    ).toEqual(input);
  });
  it("exports exact diagnostic values and SQL as CSV, preserving failures", async () => {
    const run = createVerificationRun(projectId, {
      sourceRunId: null,
      modelVersion: "model-v1",
      trigger: "manual",
    });
    updateVerificationRun(projectId, run.id, { total: 1 });
    appendVerificationResult(projectId, run.id, check);
    updateVerificationRun(projectId, run.id, { status: "succeeded" });
    const response = await download(request(), context(projectId, run.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain(run.id);
    const csv = await response.text();
    expect(csv).toContain('"fail"');
    expect(csv).toContain('"2003","2000","-3"');
    expect(csv).toContain("SELECT COUNT_BIG(*)");
    expect(csv).toContain("Inspect the input fixture");
    expect(csv).not.toContain("2,003");
  });
  it("keeps IDs project-scoped and returns useful 400/404 errors", async () => {
    const other = projectFixture(LOCAL_WORKSPACE_ID),
      foreign = createVerificationRun(other, {
        sourceRunId: null,
        modelVersion: null,
        trigger: "manual",
      });
    expect(
      (await detail(request(), context(projectId, foreign.id))).status,
    ).toBe(404);
    expect(
      (await download(request(), context(projectId, foreign.id))).status,
    ).toBe(404);
    expect(
      (await cancel(request("POST"), context(projectId, foreign.id))).status,
    ).toBe(404);
    expect((await history(request(), context("not-a-uuid"))).status).toBe(400);
    expect(
      (await detail(request(), context(projectId, "bad-run"))).status,
    ).toBe(400);
  });
  it("requires editor access for history, runs, settings and downloads, with 404 for another tenant", async () => {
    vi.stubEnv("DATAFORGE_AUTH", "on");
    const owner = userFixture(),
      editor = userFixture(),
      foreignOwner = userFixture(),
      workspace = workspaceFixture(owner),
      otherWorkspace = workspaceFixture(foreignOwner),
      a = projectFixture(workspace),
      b = projectFixture(otherWorkspace);
    memberFixture(workspace, editor, "viewer");
    const foreign = asUser(foreignOwner, otherWorkspace, () =>
      createVerificationRun(b, {
        sourceRunId: null,
        modelVersion: null,
        trigger: "manual",
      }),
    );
    expect(
      (
        await history(
          authRequest(editor, `/api/projects/${a}/checks`),
          context(a),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await start(
          authRequest(editor, `/api/projects/${a}/checks`, "POST", {}),
          context(a),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await settings(
          authRequest(editor, `/api/projects/${a}/checks/settings`, "PUT", {}),
          context(a),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await detail(
          authRequest(owner, `/api/projects/${b}/checks/${foreign.id}`),
          context(b, foreign.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (await history(new Request("http://localhost/checks"), context(a)))
        .status,
    ).toBe(401);
  });
});
