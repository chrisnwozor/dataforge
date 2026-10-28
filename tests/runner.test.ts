import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { POST as upload } from "@/app/api/projects/route";
import { saveConnection, readPublicConnection } from "@/lib/server/connection";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createQueuedRun, getRun } from "@/lib/server/runs";
import {
  cancelRun,
  recoverInterruptedRuns,
  startRun,
  waitForRunCompletion,
  type RunnerDependencies,
} from "@/lib/runner";
import {
  type SqlTransport,
  type SqlRunSummary,
} from "@/lib/runner/sql-transport";
import type { CreateProjectResponse } from "@/lib/server/uploads";

let directory: string;
const password = 'do-not-leak-"quote"/slash\\end';
const csv =
  "Order ID,Customer Name,Segment,Region,Sales\nO-1,Alice,Consumer,East,12.30\nO-2,Bob,Corporate,West,21.60\nO-3,Alice,Consumer,West,12.30\nO-4,Bob,Corporate,East,21.60\n";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-runner-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("DATAFORGE_BATCH_TIMEOUT_MS", "600000");
  vi.stubEnv("DATAFORGE_STAGING_WRITE_DIR", directory);
  saveConnection({
    server: "localhost",
    port: 1433,
    database: "DataForge",
    user: "sql-user",
    password,
    encrypt: true,
    trustServerCertificate: true,
    stagingFolder: directory,
  });
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
async function project() {
  const form = new FormData();
  form.set("name", "Runner sales");
  form.set("file", new File([csv], "sales.csv", { type: "text/csv" }));
  const response = await upload(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateProjectResponse).project;
}

interface FakeOptions {
  failBatch?: number;
  blockBatch?: boolean;
  blockClose?: Promise<void>;
  summary?: SqlRunSummary;
  connectFailure?: Error;
}
function fake(options: FakeOptions = {}) {
  const events: string[] = [];
  const batches: string[] = [];
  let rejectBatch: ((failure: Error) => void) | undefined;
  let notifyStarted!: () => void;
  const batchStarted = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const transport: SqlTransport = {
    async connect() {
      events.push("connect");
      if (options.connectFailure) throw options.connectFailure;
    },
    async batch(sql) {
      batches.push(sql);
      events.push(`batch:${batches.length}`);
      notifyStarted();
      if (options.blockBatch)
        await new Promise<void>((_resolve, reject) => {
          rejectBatch = reject;
        });
      if (options.failBatch === batches.length)
        throw Object.assign(new Error(`Bad numeric value ${password}`), {
          number: 245,
          lineNumber: 17,
          code: "EREQUEST",
        });
      return { rowsAffected: [1, 2] };
    },
    async summary() {
      events.push("summary");
      return (
        options.summary ?? {
          rowsStaged: 4,
          rowsLoaded: 4,
          rowsRejected: 0,
          rejected: [],
        }
      );
    },
    async rollback() {
      events.push("rollback");
    },
    cancel() {
      events.push("cancel");
      rejectBatch?.(Object.assign(new Error("Cancelled"), { code: "ECANCEL" }));
    },
    async close() {
      events.push("close-start");
      await options.blockClose;
      events.push("close-finished");
    },
  };
  const createTransport: RunnerDependencies["createTransport"] = (
    _settings,
    _timeout,
    info,
  ) => {
    info({ message: `PRINT ${password}`, class: 0 });
    info({ message: "Low severity warning", class: 10, number: 50000 });
    return transport;
  };
  return {
    transport,
    events,
    batches,
    batchStarted,
    dependencies: {
      createTransport,
      stageSource: async () => {
        events.push("stage");
      },
    } satisfies Partial<RunnerDependencies>,
  };
}

describe("server-only generated SQL runner", () => {
  it("recovers interrupted records when a container has reused the owner's PID", async () => {
    const p = await project();
    const old = createQueuedRun(
      p.id,
      { incremental: false, dedupe: false, db: "DataForge" },
      ["00_setup.sql"],
    );
    getDatabase()
      .prepare("UPDATE runs SET started_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", old.id);
    recoverInterruptedRuns();
    expect(getRun(old.id)).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("process stopped"),
    });
    const current = createQueuedRun(
      p.id,
      { incremental: false, dedupe: false, db: "DataForge" },
      ["00_setup.sql"],
    );
    recoverInterruptedRuns();
    expect(getRun(current.id)?.status).toBe("queued");
  });
  it("returns a queued run before sequential batches and persists actual counts after connection cleanup", async () => {
    const p = await project();
    const driver = fake();
    const queued = await startRun(
      p.id,
      { connectionUpdatedAt: readPublicConnection().updatedAt! },
      driver.dependencies,
    );
    expect(queued.status).toBe("queued");
    expect(driver.events).toEqual([]);
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run).toMatchObject({
      status: "succeeded",
      mode: "full",
      rowsStaged: 4,
      rowsLoaded: 4,
      rowsRejected: 0,
    });
    expect(detail.steps.map((s) => s.status)).toEqual(
      Array(6).fill("succeeded"),
    );
    expect(driver.batches).toHaveLength(12);
    expect(
      driver.batches
        .filter((sql) => sql.startsWith("-- DataForge:"))
        .map((sql) => sql.match(/-- DataForge: ([^\n]+)/)?.[1]),
    ).toEqual([
      "00_setup",
      "01_staging",
      "02_dim_date",
      "03_dimensions",
      "04_fact",
      "05_checks",
    ]);
    expect(
      driver.batches.filter((sql) => sql.includes("DECLARE @RunId")),
    ).toHaveLength(6);
    for (const sql of driver.batches.filter((sql) =>
      sql.includes("DECLARE @RunId"),
    )) {
      expect(sql).toContain(queued.id);
      expect(sql).toContain("SET NOCOUNT OFF;");
      expect(sql).not.toContain("SET NOCOUNT ON;");
    }
    const staging = driver.batches.find((sql) =>
      sql.includes("DECLARE @FilePath"),
    )!;
    expect(staging).toContain(`${p.id}.csv`);
    expect(staging).not.toContain("REPLACE_WITH_CLEANED_SOURCE");
    expect(driver.events.slice(-3)).toEqual([
      "summary",
      "close-start",
      "close-finished",
    ]);
    expect(JSON.stringify(detail)).not.toContain(password);
    expect(
      detail.logs.some(
        (l) => l.level === "WARN" && l.message.includes("Low severity"),
      ),
    ).toBe(true);
    expect(detail.logs.some((l) => l.message.includes("3 rows affected"))).toBe(
      true,
    );
  });
  it("stops at the first failing batch, rolls back, records SQL metadata, and skips later files", async () => {
    const p = await project();
    const driver = fake({ failBatch: 5 });
    const queued = await startRun(p.id, {}, driver.dependencies);
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run).toMatchObject({
      status: "failed",
      errorFile: "02_dim_date.sql",
      errorBatch: 1,
      errorNumber: 245,
      errorLine: 17,
    });
    expect(driver.batches).toHaveLength(5);
    expect(driver.events).toContain("rollback");
    expect(driver.events).not.toContain("summary");
    expect(detail.steps.map((s) => s.status)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(detail.run.errorMessage).toContain("[redacted]");
    expect(JSON.stringify(detail)).not.toContain(password);
  });
  it("keeps the per-project lock until cancelled requests, rollback, and close have settled", async () => {
    const p = await project();
    let finishClose!: () => void;
    const closing = new Promise<void>((r) => {
      finishClose = r;
    });
    const driver = fake({ blockBatch: true, blockClose: closing });
    const queued = await startRun(p.id, {}, driver.dependencies);
    await driver.batchStarted;
    await expect(startRun(p.id, {}, fake().dependencies)).rejects.toMatchObject(
      { status: 409 },
    );
    const cancellation = cancelRun(p.id, queued.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(driver.events).toContain("cancel");
    expect(driver.events).toContain("rollback");
    expect(getRun(queued.id)?.status).toBe("running");
    await expect(startRun(p.id, {}, fake().dependencies)).rejects.toMatchObject(
      { status: 409 },
    );
    finishClose();
    expect((await cancellation).run.status).toBe("cancelled");
    expect(driver.events.at(-1)).toBe("close-finished");
    const next = await startRun(p.id, {}, fake().dependencies);
    expect((await waitForRunCompletion(next.id)).run.status).toBe("succeeded");
  });
  it("cancels queued work without contacting SQL Server", async () => {
    const p = await project();
    const driver = fake();
    const queued = await startRun(p.id, {}, driver.dependencies);
    const detail = await cancelRun(p.id, queued.id);
    expect(detail.run.status).toBe("cancelled");
    expect(driver.events).toEqual([]);
    expect(detail.steps.every((s) => s.status === "skipped")).toBe(true);
    await expect(cancelRun(p.id, queued.id)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("persists first rejected rows with valid JSON and redacts escaped credentials in all output", async () => {
    const p = await project();
    const sqlJson = JSON.stringify({
      value: password,
      nested: { secret: process.env.DATAFORGE_SECRET },
    }).replaceAll("/", "\\/");
    const driver = fake({
      summary: {
        rowsStaged: 4,
        rowsLoaded: 3,
        rowsRejected: 1,
        rejected: [
          { sourceRowNumber: 2, reason: `Bad ${password}`, rawJson: sqlJson },
        ],
      },
    });
    const queued = await startRun(p.id, {}, driver.dependencies);
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run.rowsRejected).toBe(1);
    expect(JSON.parse(detail.rejected[0].rawJson)).toEqual({
      value: "[redacted]",
      nested: { secret: "[redacted]" },
    });
    expect(JSON.stringify(detail)).not.toContain(password);
  });
  it("writes a real cleaned staging CSV while the injected transport never contacts SQL Server", async () => {
    const p = await project();
    const driver = fake();
    const queued = await startRun(
      p.id,
      {},
      { createTransport: driver.dependencies.createTransport },
    );
    expect((await waitForRunCompletion(queued.id)).run.status).toBe(
      "succeeded",
    );
    expect(readFileSync(join(directory, `${p.id}.csv`), "utf8")).toBe(csv);
  });
  it("fails clearly before executing scripts when staging or connection setup fails", async () => {
    const p = await project();
    const driver = fake();
    const queued = await startRun(
      p.id,
      {},
      {
        ...driver.dependencies,
        stageSource: async () => {
          throw new Error("Staging is not writable");
        },
      },
    );
    const failed = await waitForRunCompletion(queued.id);
    expect(failed.run).toMatchObject({
      status: "failed",
      errorFile: "01_staging.sql",
      errorMessage: "Staging is not writable",
    });
    expect(driver.events).toEqual([]);
    const network = fake({
      connectFailure: Object.assign(new Error(`Cannot connect ${password}`), {
        code: "ESOCKET",
      }),
    });
    const connecting = await startRun(p.id, {}, network.dependencies);
    const result = await waitForRunCompletion(connecting.id);
    expect(result.run.errorMessage).toMatch(/Cannot reach SQL Server/);
    expect(network.batches).toHaveLength(0);
    expect(network.events).toContain("close-finished");
  });
  it("rejects changed confirmed targets and unsupported timeouts before queuing", async () => {
    const p = await project();
    await expect(
      startRun(
        p.id,
        { connectionUpdatedAt: "2000-01-01T00:00:00.000Z" },
        fake().dependencies,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      startRun(p.id, { db: "OtherDatabase" }, fake().dependencies),
    ).rejects.toMatchObject({ status: 409 });
    vi.stubEnv("DATAFORGE_BATCH_TIMEOUT_MS", "Infinity");
    await expect(startRun(p.id, {}, fake().dependencies)).rejects.toMatchObject(
      { status: 503 },
    );
    expect(
      getDatabase().prepare("SELECT COUNT(*) AS count FROM runs").get()?.count,
    ).toBe(0);
  });
  it("records actual full mode when incremental is requested without a date", async () => {
    const p = await project();
    const driver = fake();
    const queued = await startRun(
      p.id,
      { incremental: true },
      driver.dependencies,
    );
    const detail = await waitForRunCompletion(queued.id);
    expect(detail.run).toMatchObject({
      mode: "full",
      options: { incremental: false },
    });
    expect(
      driver.batches.some((sql) =>
        sql.includes("TRUNCATE TABLE [dw].[fact_sales]"),
      ),
    ).toBe(true);
    expect(
      detail.logs.some(
        (l) => l.level === "WARN" && l.message.includes("full refresh"),
      ),
    ).toBe(true);
  });
});
