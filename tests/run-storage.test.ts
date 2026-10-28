import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  appendLog,
  canTransitionRun,
  createQueuedRun,
  findActiveRun,
  getRun,
  getRunDetail,
  getRunOwnerPid,
  listActiveRuns,
  listRuns,
  saveRejectedRows,
  transitionRun,
  updateRun,
  updateStep,
} from "@/lib/server/runs";
import type { RunOptions } from "@/lib/runner/types";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-run-storage-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
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
const options: RunOptions = {
  incremental: false,
  dedupe: true,
  db: "Warehouse",
};
const files = [
  "00_setup.sql",
  "01_staging.sql",
  "02_dim_date.sql",
  "03_dimensions.sql",
  "04_fact.sql",
  "05_checks.sql",
];

describe("SQLite run persistence and state machine", () => {
  it("starts empty and persists the queued record, step ordering, logs, errors and rejected preview across reopen", () => {
    const id = project();
    expect(listRuns(id)).toEqual([]);
    const run = createQueuedRun(id, options, files);
    expect(run).toMatchObject({
      projectId: id,
      status: "queued",
      mode: "full",
      options,
      rowsStaged: 0,
      rowsLoaded: 0,
      rowsRejected: 0,
    });
    expect(getRunOwnerPid(run.id)).toBe(process.pid);
    transitionRun(run.id, "running");
    updateStep(run.id, 0, { status: "running" });
    updateStep(run.id, 0, {
      status: "succeeded",
      rowsAffected: 12,
      message: "Setup completed",
    });
    const first = appendLog(
      run.id,
      "INFO",
      "Server says O'Brien's import is ready",
    );
    const second = appendLog(run.id, "WARN", "One bad measure");
    expect(second.id).toBeGreaterThan(first.id);
    saveRejectedRows(run.id, [
      {
        sourceRowNumber: 3,
        reason: "Invalid measure",
        rawJson: JSON.stringify({ Sales: "not numeric" }),
      },
    ]);
    updateRun(run.id, {
      rowsStaged: 2,
      rowsLoaded: 1,
      rowsRejected: 1,
      errorFile: "04_fact.sql",
      errorBatch: 2,
      errorNumber: 245,
      errorLine: 6,
      errorMessage: "Conversion failed",
    });
    transitionRun(run.id, "failed");
    closeDatabase();
    const detail = getRunDetail(run.id)!;
    expect(detail.run).toMatchObject({
      status: "failed",
      rowsStaged: 2,
      rowsLoaded: 1,
      rowsRejected: 1,
      errorBatch: 2,
      errorNumber: 245,
      errorLine: 6,
    });
    expect(detail.run.finishedAt).not.toBeNull();
    expect(detail.steps.map((step) => step.file)).toEqual(files);
    expect(detail.steps[0]).toMatchObject({
      status: "succeeded",
      rowsAffected: 12,
      message: "Setup completed",
    });
    expect(detail.steps[0].startedAt).not.toBeNull();
    expect(detail.steps[0].finishedAt).not.toBeNull();
    expect(detail.logs.map((log) => log.message)).toEqual([
      "Server says O'Brien's import is ready",
      "One bad measure",
    ]);
    expect(detail.rejected).toEqual([
      {
        sourceRowNumber: 3,
        reason: "Invalid measure",
        rawJson: '{"Sales":"not numeric"}',
      },
    ]);
    expect(getRun(randomUUID())).toBeUndefined();
  });
  it("atomically permits only one active run per project and releases the durable lock only after a terminal state", () => {
    const id = project();
    const other = project();
    const first = createQueuedRun(id, options, files);
    expect(() => createQueuedRun(id, options, files)).toThrow(/already active/);
    expect(listRuns(id)).toHaveLength(1);
    expect(getRunDetail(first.id)!.steps).toHaveLength(6);
    const independent = createQueuedRun(
      other,
      { ...options, incremental: true },
      files,
    );
    expect(independent.mode).toBe("incremental");
    expect(listActiveRuns()).toHaveLength(2);
    transitionRun(first.id, "running");
    expect(() => createQueuedRun(id, options, files)).toThrow(/already active/);
    transitionRun(first.id, "cancelled");
    expect(findActiveRun(id)).toBeUndefined();
    expect(createQueuedRun(id, options, files).id).not.toBe(first.id);
  });
  it("rejects invalid and terminal transitions without losing completed results", () => {
    const run = createQueuedRun(project(), options, files);
    expect(() => transitionRun(run.id, "succeeded")).toThrow(
      /queued run cannot/,
    );
    transitionRun(run.id, "running");
    transitionRun(run.id, "succeeded", { rowsLoaded: 2, rowsStaged: 2 });
    expect(() => transitionRun(run.id, "running")).toThrow(
      /succeeded run cannot/,
    );
    expect(() => transitionRun(run.id, "failed")).toThrow(
      /succeeded run cannot/,
    );
    expect(() => updateRun(run.id, { rowsLoaded: -1 })).toThrow(/nonnegative/);
    expect(getRun(run.id)).toMatchObject({
      status: "succeeded",
      rowsLoaded: 2,
    });
    for (const final of ["succeeded", "failed", "cancelled"] as const) {
      expect(canTransitionRun(final, "running")).toBe(false);
      expect(canTransitionRun(final, "queued")).toBe(false);
    }
  });
  it("limits rejected previews to100 and does not persist unknown option or secret fields", () => {
    const id = project();
    expect(() =>
      createQueuedRun(
        id,
        { ...options, password: "not allowed" } as RunOptions,
        files,
      ),
    ).toThrow(/Invalid run options/);
    expect(listRuns(id)).toEqual([]);
    const run = createQueuedRun(id, options, files);
    saveRejectedRows(
      run.id,
      Array.from({ length: 125 }, (_, index) => ({
        sourceRowNumber: index + 2,
        reason: "Invalid date",
        rawJson: '{"date":"bad"}',
      })),
    );
    expect(getRunDetail(run.id)!.rejected).toHaveLength(100);
    expect(getRunDetail(run.id)!.rejected.at(-1)!.sourceRowNumber).toBe(101);
    expect(JSON.stringify(run)).not.toContain("owner_pid");
    getDatabase().prepare("DELETE FROM projects WHERE id = ?").run(id);
    expect(getRun(run.id)).toBeUndefined();
    expect(
      getDatabase().prepare("SELECT COUNT(*) AS count FROM run_steps").get()!
        .count,
    ).toBe(0);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM run_reject_rows")
        .get()!.count,
    ).toBe(0);
  });
  it("preserves finished step states and marks unexecuted steps skipped", () => {
    const run = createQueuedRun(project(), options, files);
    updateStep(run.id, 0, { status: "running" });
    updateStep(run.id, 0, { status: "succeeded" });
    expect(() => updateStep(run.id, 0, { status: "running" })).toThrow(
      /succeeded step cannot/,
    );
    updateStep(run.id, 1, {
      status: "skipped",
      message: "Earlier script failed",
    });
    expect(getRunDetail(run.id)!.steps[1]).toMatchObject({
      status: "skipped",
      message: "Earlier script failed",
    });
  });
});
