import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { LOCAL_WORKSPACE_ID } from "@/lib/auth/migrations";
import {
  asUser,
  memberFixture,
  projectFixture,
  userFixture,
  workspaceFixture,
} from "./helpers/auth";
import {
  appendVerificationResult,
  createVerificationRun,
  findActiveVerificationRun,
  getVerificationOwnerPid,
  getVerificationRun,
  getVerificationSnapshot,
  listVerificationRuns,
  readCheckSettings,
  saveCheckSettings,
  updateVerificationRun,
} from "@/lib/server/verification-storage";
import type { CheckResult } from "@/lib/verify/types";

let directory: string, projectId: string;
const create = (id = projectId) =>
  createVerificationRun(id, {
    sourceRunId: null,
    modelVersion: "model-v1",
    trigger: "manual",
    snapshot: { pipelineVersion: 3, source: "snapshot.csv" },
  });
const result = (
  status: CheckResult["status"],
  id = `check-${status}`,
): CheckResult => ({
  id,
  area: "Ingestion",
  name: "Prepared rows reconcile",
  status,
  expected: 2000,
  actual: status === "fail" ? 1999 : 2000,
  difference: status === "fail" ? -1 : 0,
  tolerance: 0.01,
  elapsedMs: 12.25,
  explanation: "Compare independent prepared rows and warehouse rows.",
  nextStep:
    status === "fail"
      ? "Inspect the staged and rejected rows."
      : "No action needed.",
  sql: "SELECT COUNT_BIG(*) FROM [dw].[fact_sales]",
  referenceSql: "Streaming Node reference",
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-verification-storage-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "off");
  projectId = projectFixture(LOCAL_WORKSPACE_ID);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("versioned check history and progress", () => {
  it("defaults to manual checks, persists settings/snapshot and survives reopening SQLite", () => {
    expect(listVerificationRuns(projectId)).toEqual([]);
    expect(readCheckSettings(projectId)).toEqual({
      version: 1,
      autoAfterLoad: false,
      absoluteTolerance: 0.01,
      relativeTolerance: 0.000001,
    });
    saveCheckSettings(projectId, {
      version: 1,
      autoAfterLoad: true,
      absoluteTolerance: 0.005,
      relativeTolerance: 0.00001,
    });
    const run = create();
    expect(run).toMatchObject({
      projectId,
      workspaceId: LOCAL_WORKSPACE_ID,
      status: "queued",
      completed: 0,
      results: [],
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0 },
    });
    expect(findActiveVerificationRun(projectId)?.id).toBe(run.id);
    expect(getVerificationOwnerPid(projectId, run.id)).toBe(process.pid);
    closeDatabase();
    expect(getVerificationRun(projectId, run.id)).toEqual(run);
    expect(getVerificationSnapshot(projectId, run.id)).toEqual({
      pipelineVersion: 3,
      source: "snapshot.csv",
    });
    expect(readCheckSettings(projectId).autoAfterLoad).toBe(true);
  });
  it("reconciles persisted totals against an independent SQL status aggregation and exposes compact history", () => {
    const run = create();
    updateVerificationRun(projectId, run.id, {
      status: "running",
      total: 5,
      currentCheck: "First check",
    });
    for (const [index, state] of (
      ["pass", "fail", "warn", "skipped", "pass"] as const
    ).entries())
      appendVerificationResult(
        projectId,
        run.id,
        result(state, `check-${index}`),
      );
    const complete = updateVerificationRun(projectId, run.id, {
      status: "succeeded",
    });
    expect(complete.finishedAt).not.toBeNull();
    const independent = Object.fromEntries(
      getDatabase()
        .prepare(
          "SELECT json_extract(result_json,'$.status') AS status,COUNT(*) AS n FROM verification_results WHERE run_id=? GROUP BY json_extract(result_json,'$.status')",
        )
        .all(run.id)
        .map((row) => [row.status, row.n]),
    );
    expect(complete.counts).toEqual(independent);
    expect(complete.completed).toBe(
      Object.values(independent).reduce(
        (sum, count) => Number(sum) + Number(count),
        0,
      ),
    );
    const full = getVerificationRun(projectId, run.id);
    expect(full.results.map((check) => check.status)).toEqual([
      "pass",
      "fail",
      "warn",
      "skipped",
      "pass",
    ]);
    expect(full.currentCheck).toBeNull();
    const history = listVerificationRuns(projectId);
    expect(history).toHaveLength(1);
    expect(history[0].results).toEqual([]);
    expect(history[0].counts).toEqual(full.counts);
    expect(history[0].completed).toBe(5);
  });
  it("enforces one durable active run per project while allowing other projects", () => {
    const run = create();
    expect(() => create()).toThrow(/already active/);
    const other = projectFixture(LOCAL_WORKSPACE_ID);
    expect(create(other).projectId).toBe(other);
    updateVerificationRun(projectId, run.id, { status: "cancelled" });
    expect(create().id).not.toBe(run.id);
  });
  it("rejects premature success, impossible progress, duplicate results and terminal-state mutation", () => {
    const run = create();
    updateVerificationRun(projectId, run.id, { status: "running", total: 2 });
    expect(() =>
      updateVerificationRun(projectId, run.id, { status: "succeeded" }),
    ).toThrow(/every check/);
    appendVerificationResult(projectId, run.id, result("pass"));
    expect(() =>
      appendVerificationResult(projectId, run.id, result("pass")),
    ).toThrow(/already/);
    expect(() =>
      updateVerificationRun(projectId, run.id, { completed: 2 }),
    ).toThrow(/reconcile/);
    expect(() =>
      updateVerificationRun(projectId, run.id, { total: 0 }),
    ).toThrow(/smaller/);
    updateVerificationRun(projectId, run.id, { status: "cancelled" });
    expect(() =>
      appendVerificationResult(projectId, run.id, result("fail")),
    ).toThrow(/finished/);
    expect(() =>
      updateVerificationRun(projectId, run.id, { status: "running" }),
    ).toThrow(/finished/);
  });
  it("rejects invalid payloads and future settings versions without replacing stored values", () => {
    saveCheckSettings(projectId, {
      version: 1,
      autoAfterLoad: true,
      absoluteTolerance: 0.1,
      relativeTolerance: 0,
    });
    for (const value of [
      { version: 2 },
      { version: 1, absoluteTolerance: -1 },
      { version: 1, relativeTolerance: Infinity },
      { version: 1, sql: "SELECT secret" },
    ])
      expect(() => saveCheckSettings(projectId, value)).toThrow();
    expect(readCheckSettings(projectId).autoAfterLoad).toBe(true);
    const run = create();
    updateVerificationRun(projectId, run.id, { total: 1 });
    expect(() =>
      appendVerificationResult(projectId, run.id, {
        ...result("pass"),
        actual: Infinity,
      }),
    ).toThrow();
    expect(getVerificationRun(projectId, run.id).completed).toBe(0);
  });
  it("reports corrupted results, counts, and versioned snapshots without silently repairing history", () => {
    const run = create();
    updateVerificationRun(projectId, run.id, { total: 1 });
    appendVerificationResult(projectId, run.id, result("pass"));
    getDatabase()
      .prepare("UPDATE verification_runs SET counts_json=? WHERE id=?")
      .run(JSON.stringify({ pass: 0, warn: 1, fail: 0, skipped: 0 }), run.id);
    expect(() => getVerificationRun(projectId, run.id)).toThrow(
      /does not reconcile/,
    );
    expect(() => listVerificationRuns(projectId)).toThrow(/does not reconcile/);
    getDatabase()
      .prepare("UPDATE verification_runs SET counts_json=? WHERE id=?")
      .run(JSON.stringify({ pass: 1, warn: 0, fail: 0, skipped: 0 }), run.id);
    getDatabase()
      .prepare("UPDATE verification_results SET result_json=? WHERE run_id=?")
      .run('{"version":999}', run.id);
    expect(() => getVerificationRun(projectId, run.id)).toThrow(/invalid/);
    expect(
      getDatabase()
        .prepare("SELECT result_json FROM verification_results WHERE run_id=?")
        .get(run.id)?.result_json,
    ).toBe('{"version":999}');
    getDatabase()
      .prepare("DELETE FROM verification_results WHERE run_id=?")
      .run(run.id);
    getDatabase()
      .prepare(
        "UPDATE verification_runs SET completed=0,counts_json=?,snapshot_json=? WHERE id=?",
      )
      .run(
        JSON.stringify({ pass: 0, warn: 0, fail: 0, skipped: 0 }),
        '{"version":999,"data":{}}',
        run.id,
      );
    expect(() => getVerificationSnapshot(projectId, run.id)).toThrow(
      /unsupported version/,
    );
  });
  it("scopes source load records and does not attach failed or foreign loads", () => {
    const loadId = randomUUID(),
      other = projectFixture(LOCAL_WORKSPACE_ID),
      db = getDatabase();
    db.prepare(
      "INSERT INTO runs(id,project_id,status,mode,started_at,options_json,workspace_id) VALUES(?,?,'succeeded','full',?,?,?)",
    ).run(
      loadId,
      other,
      new Date().toISOString(),
      JSON.stringify({ db: "Warehouse", incremental: false, dedupe: true }),
      LOCAL_WORKSPACE_ID,
    );
    expect(() =>
      createVerificationRun(projectId, {
        sourceRunId: loadId,
        modelVersion: null,
        trigger: "load",
      }),
    ).toThrow(/not found/);
    expect(
      createVerificationRun(other, {
        sourceRunId: loadId,
        modelVersion: null,
        trigger: "load",
      }).sourceRunId,
    ).toBe(loadId);
    db.prepare("UPDATE runs SET status='failed' WHERE id=?").run(loadId);
    updateVerificationRun(other, findActiveVerificationRun(other)!.id, {
      status: "cancelled",
      sourceRunId: null,
    });
    expect(() =>
      createVerificationRun(other, {
        sourceRunId: loadId,
        modelVersion: null,
        trigger: "load",
      }),
    ).toThrow(/successful/);
  });
  it("limits list history to the newest 100 records without deleting older evidence", () => {
    for (let index = 0; index < 102; index++) {
      const run = create();
      updateVerificationRun(projectId, run.id, { status: "succeeded" });
      getDatabase()
        .prepare("UPDATE verification_runs SET started_at=? WHERE id=?")
        .run(new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), run.id);
    }
    const history = listVerificationRuns(projectId);
    expect(history).toHaveLength(100);
    expect(history[0].startedAt).toBe("2026-01-01T01:41:00.000Z");
    expect(
      getDatabase()
        .prepare(
          "SELECT COUNT(*) AS n FROM verification_runs WHERE project_id=?",
        )
        .get(projectId)?.n,
    ).toBe(102);
  });
});

describe("checks tenant and role isolation", () => {
  it("denies foreign project/run/settings IDs and read-only viewers", () => {
    vi.stubEnv("DATAFORGE_AUTH", "on");
    const alice = userFixture(),
      bob = userFixture(),
      alpha = workspaceFixture(alice),
      beta = workspaceFixture(bob),
      a = projectFixture(alpha),
      b = projectFixture(beta);
    const foreign = asUser(bob, beta, () => create(b));
    memberFixture(alpha, bob, "viewer");
    asUser(alice, alpha, () => {
      for (const read of [
        () => listVerificationRuns(b),
        () => getVerificationRun(b, foreign.id),
        () => readCheckSettings(b),
        () => saveCheckSettings(b, {}),
        () => getVerificationSnapshot(b, foreign.id),
        () => getVerificationOwnerPid(b, foreign.id),
      ])
        expect(read).toThrow(/not found/);
      expect(() => getVerificationRun(a, foreign.id)).toThrow(/not found/);
    });
    asUser(bob, alpha, () =>
      expect(() => listVerificationRuns(a)).toThrow(/role/),
    );
  });
});
