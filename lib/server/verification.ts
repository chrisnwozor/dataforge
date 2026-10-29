import { stat } from "node:fs/promises";
import {
  createJobAccess,
  localMode,
  requireProjectAccess,
} from "@/lib/auth/context";
import { auditEvent } from "@/lib/auth/audit";
import { redactSecrets } from "@/lib/runner/secrets";
import type {
  CheckCase,
  CheckOutcome,
  CheckRun,
  CheckSettings,
  EngineExecutor,
  ReferenceExecutor,
  VerificationColumn,
  WarehouseLoadReference,
} from "@/lib/verify/types";
import type { SemanticModel } from "@/lib/semantic/types";
import type { SemanticQuery } from "@/lib/semantic/query/types";
import { runChecks } from "@/lib/verify/runner";
import { computePreparedReference } from "@/lib/verify/prepared";
import { createIngestionChecks } from "@/lib/verify/ingestion";
import { createSemanticChecks } from "@/lib/verify/semantic";
import { createReportChecks } from "@/lib/verify/reports";
import {
  createDashboardChecks,
  collectDashboardObservation,
} from "@/lib/verify/dashboards";
import {
  preparedSnapshotPath,
  PreparedSnapshotUnavailable,
} from "@/lib/verify/snapshot";
import { getDatabase, dataDirectory } from "./db";
import { HttpError } from "./http";
import { findProject, readColumnProfiles } from "./projects";
import { findActiveRun, listRuns } from "./runs";
import { readPipeline } from "./prepare-storage";
import { readPublicConnection } from "./connection";
import {
  getSemanticModel,
  readSemanticStamp,
  requireSemanticReady,
} from "./semantic";
import { runSemanticQuery } from "./semantic-query";
import { queryScheduler, queryServerKey } from "./query-scheduler";
import { executeCompiledQuery } from "./query-transport";
import { listReports } from "./reports";
import { executeReportData } from "./report-runner";
import { paginateReport } from "@/lib/reports/pagination";
import { generateReportExport } from "@/lib/reports/export";
import { listDashboards } from "./dashboards";
import { listExploreViews } from "./explore-views";
import {
  appendVerificationResult,
  createVerificationRun,
  findActiveVerificationRun,
  getVerificationRun,
  getVerificationOwnerPid,
  readCheckSettings,
  updateVerificationRun,
} from "./verification-storage";

export interface VerificationSnapshot {
  version: 1;
  sourceRunId: string | null;
  semanticStamp: string;
  pipelineVersion: number | null;
  connectionVersion: string | null;
  modelVersion: string | null;
  artifactStamp: string;
}
export interface VerificationPlan {
  checks: CheckCase[];
  snapshot?: unknown;
  modelVersion?: string | null;
}
export interface VerificationDependencies {
  plan(
    projectId: string,
    run: CheckRun,
    settings: CheckSettings,
    signal: AbortSignal,
  ): Promise<VerificationPlan>;
  assertSnapshot?(projectId: string, snapshot: unknown): Promise<void> | void;
}
interface VerificationJob {
  projectId: string;
  workspaceId: string;
  controller: AbortController;
  done: Promise<void>;
  access: ReturnType<typeof createJobAccess>;
}
const state = globalThis as typeof globalThis & {
  dataforgeVerificationJobs?: Map<string, VerificationJob>;
};
const jobs = (state.dataforgeVerificationJobs ??= new Map());
const key = (projectId: string) => `${dataDirectory()}:${projectId}`;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const empty: (
  explanation: string,
  status?: CheckOutcome["status"],
) => CheckOutcome = (explanation, status = "skipped") => ({
  status,
  expected: null,
  actual: null,
  difference: null,
  tolerance: 0,
  explanation,
  nextStep:
    "Configure a connection, prepare the project, and complete a successful load, then rerun Checks.",
  sql: "",
});
const unavailable = (
  id: string,
  area: CheckCase["area"],
  name: string,
  message: string,
  status: CheckOutcome["status"] = "skipped",
): CheckCase => ({ id, area, name, run: async () => empty(message, status) });
function latestLoad(projectId: string): WarehouseLoadReference | null {
  const connection = readPublicConnection();
  const value = listRuns(projectId).find(
    (run) =>
      run.status === "succeeded" &&
      (!connection.configured || run.options.db === connection.database),
  );
  return value
    ? {
        id: value.id,
        mode: value.mode,
        rowsStaged: value.rowsStaged,
        rowsLoaded: value.rowsLoaded,
        rowsRejected: value.rowsRejected,
        dedupe: value.options.dedupe,
        finishedAt: value.finishedAt,
      }
    : null;
}
function artifacts(projectId: string) {
  const reports = listReports(projectId),
    dashboards = listDashboards(projectId),
    views = listExploreViews(projectId);
  return {
    reports,
    dashboards,
    views,
    stamp: JSON.stringify([
      reports.map((r) => [r.id, r.updatedAt]),
      dashboards.map((d) => [d.id, d.updatedAt]),
      views.map((v) => [v.id, v.updatedAt]),
    ]),
  };
}
async function snapshot(
  projectId: string,
  modelVersion: string | null,
): Promise<VerificationSnapshot> {
  return {
    version: 1,
    sourceRunId: latestLoad(projectId)?.id ?? null,
    semanticStamp: readSemanticStamp(projectId),
    pipelineVersion: readPipeline(projectId)?.version ?? null,
    connectionVersion: readPublicConnection().updatedAt,
    modelVersion,
    artifactStamp: artifacts(projectId).stamp,
  };
}
export async function verificationSnapshotInfo(
  projectId: string,
): Promise<{ latestSourceRunId: string | null; modelVersion: string | null }> {
  if (!localMode()) requireProjectAccess(projectId, "editor");
  let modelVersion: string | null = null;
  try {
    modelVersion = (await getSemanticModel(projectId)).version;
  } catch (error) {
    if (!(error instanceof HttpError) || ![409, 503].includes(error.status))
      throw error;
  }
  return { latestSourceRunId: latestLoad(projectId)?.id ?? null, modelVersion };
}
async function assertUnchanged(
  projectId: string,
  input: unknown,
): Promise<void> {
  const expected = input as Partial<VerificationSnapshot> | undefined;
  if (!expected?.version) return;
  if (findActiveRun(projectId))
    throw new HttpError(
      409,
      "A new load is active. These checks stopped to avoid mixing warehouse snapshots.",
    );
  const now = await snapshot(projectId, expected.modelVersion ?? null);
  if (JSON.stringify(now) !== JSON.stringify(expected))
    throw new HttpError(
      409,
      "The model, pipeline, connection, saved views or successful load changed while checks were running. Partial results remain available; run a fresh check snapshot.",
    );
}
/** New references use the existing bounded SQL transport/queue, never client SQL. */
export function verificationExecutors(projectId: string): {
  engine: EngineExecutor;
  reference: ReferenceExecutor;
} {
  const engine: EngineExecutor = (query, signal) =>
    runSemanticQuery(
      projectId,
      { ...query, cache: "bypass" },
      signal,
      undefined,
      { priority: "checks" },
    );
  const reference: ReferenceExecutor = async (query, signal) => {
    const ready = requireSemanticReady(projectId);
    const revision = queryScheduler.getRevision(projectId);
    try {
      return await queryScheduler.schedule(
        {
          projectId,
          serverKey: queryServerKey(ready.settings.server, ready.settings.port),
          priority: "checks",
          signal,
          expectedRevision: revision,
        },
        (scheduledSignal, timeoutMs) => {
          requireProjectAccess(projectId, "editor");
          return executeCompiledQuery(
            ready.settings,
            { ...query, materialized: false },
            scheduledSignal,
            undefined,
            { timeoutMs },
          ).then((rows) =>
            rows.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([name, value]) => [
                  name,
                  value instanceof Date
                    ? query.columns.find((c) => c.key === name)?.type === "date"
                      ? value.toISOString().slice(0, 10)
                      : value.toISOString()
                    : typeof value === "bigint"
                      ? value.toString()
                      : value === null ||
                          typeof value === "string" ||
                          typeof value === "number" ||
                          typeof value === "boolean"
                        ? value
                        : String(value),
                ]),
              ),
            ),
          );
        },
      );
    } catch (error) {
      if (error instanceof Error) {
        error.message = redactSecrets(error.message, [
          ready.settings.password,
          process.env.DATAFORGE_SECRET ?? "",
        ]);
        Object.assign(error, { sql: query.sql });
      }
      throw error;
    }
  };
  return { engine, reference };
}
export async function buildVerificationPlan(
  projectId: string,
  run: CheckRun,
  settings: CheckSettings,
  signal: AbortSignal,
): Promise<VerificationPlan> {
  const metadataStamp = readSemanticStamp(projectId);
  const project = findProject(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  const columns: VerificationColumn[] = readColumnProfiles(projectId).map(
    (c) => ({
      id: String(c.ordinal),
      name: c.name,
      type: c.overrideType ?? c.inferredType,
    }),
  );
  const load = latestLoad(projectId);
  if ((load?.id ?? null) !== run.sourceRunId)
    throw new HttpError(
      409,
      "A newer successful load replaced this check run's source snapshot. Start a new check run.",
    );
  let model: SemanticModel | null = null,
    readyError = "";
  try {
    model = await getSemanticModel(projectId);
  } catch (error) {
    if (!(error instanceof HttpError) || ![409, 503].includes(error.status))
      throw error;
    readyError = error.message;
  }
  if (readSemanticStamp(projectId) !== metadataStamp)
    throw new HttpError(
      409,
      "The project profile or model changed while check metadata was being read. Start a new check run to use consistent columns and totals.",
    );
  const initialSnapshot = await snapshot(projectId, model?.version ?? null);
  if (initialSnapshot.sourceRunId !== (load?.id ?? null))
    throw new HttpError(
      409,
      "The successful load changed while check metadata was being read. Start a new check run to use a consistent snapshot.",
    );
  const checks: CheckCase[] = [],
    tolerance = {
      absolute: settings.absoluteTolerance,
      relative: settings.relativeTolerance,
    };
  let prepared: Awaited<ReturnType<typeof computePreparedReference>> | null =
    null;
  try {
    const path = await preparedSnapshotPath(projectId, load?.id ?? null),
      before = await stat(/* turbopackIgnore: true */ path);
    const tuples: Record<string, string[]> = {};
    if (model)
      for (const table of model.tables.filter((t) => t.kind === "dimension"))
        tuples[table.id] = table.columns.flatMap((c) =>
          c.sourceColumnId
            ? [columns.find((p) => p.id === c.sourceColumnId)?.name ?? c.name]
            : [],
        );
    prepared = await computePreparedReference(path, columns, {
      signal,
      dimensionTuples: tuples,
    });
    const after = await stat(/* turbopackIgnore: true */ path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error(
        "The prepared CSV changed while it was being read. Run the checks again from a stable snapshot.",
      );
    const reference = prepared;
    checks.push({
      id: "ingestion.prepared-profile",
      area: "Ingestion",
      name: "Prepared rows, duplicates and null cells match the saved profile",
      run: async () => {
        const actual = {
            rows: project.rowCount,
            duplicates: project.duplicateRowCount,
            nullCells: project.totalNullCells,
          },
          expected = {
            rows: reference.rows,
            duplicates: reference.duplicateRows,
            nullCells: reference.nullCells,
          };
        const incomplete =
          project.duplicateRowCount === null || project.totalNullCells === null;
        const same =
          reference.rows === project.rowCount &&
          (project.duplicateRowCount === null ||
            reference.duplicateRows === project.duplicateRowCount) &&
          (project.totalNullCells === null ||
            reference.nullCells === project.totalNullCells);
        return {
          status: same ? (incomplete ? "warn" : "pass") : "fail",
          expected,
          actual,
          difference: Math.max(
            Math.abs(reference.rows - project.rowCount),
            project.duplicateRowCount === null
              ? 0
              : Math.abs(reference.duplicateRows - project.duplicateRowCount),
            project.totalNullCells === null
              ? 0
              : Math.abs(reference.nullCells - project.totalNullCells),
          ),
          tolerance: 0,
          explanation:
            same && incomplete
              ? "Row counts match, but the legacy saved profile lacks duplicate/null totals. Those fields were not treated as verified."
              : same
                ? "A new streaming Node calculation agrees with the saved profiler totals; it does not call the profiler or preparation engine."
                : "The saved profile totals differ from the independent streaming pass. The source/profile may be stale or the ingestion rules may disagree.",
          nextStep: same
            ? "No action needed."
            : "Compare the prepared CSV and saved profile, re-profile or reload if the pipeline changed, and investigate the first differing metric.",
          sql: "",
        };
      },
    });
  } catch (error) {
    signal.throwIfAborted();
    checks.push(
      unavailable(
        "ingestion.prepared-profile",
        "Ingestion",
        "Prepared dataset reference",
        error instanceof Error
          ? error.message
          : "Prepared CSV could not be inspected.",
        error instanceof PreparedSnapshotUnavailable ? "skipped" : "fail",
      ),
    );
  }
  if (!model) {
    for (const area of [
      "Ingestion",
      "Semantic",
      "Reports",
      "Dashboards",
    ] as const)
      checks.push(
        unavailable(
          `${area.toLowerCase()}.sql-readiness`,
          area,
          `${area} warehouse reconciliation`,
          readyError ||
            "There is no configured connection and successful warehouse load. No SQL was executed.",
        ),
      );
  } else {
    const { engine, reference } = verificationExecutors(projectId),
      saved = artifacts(projectId);
    if (prepared)
      checks.push(
        ...createIngestionChecks(
          {
            projectId,
            model,
            prepared,
            load,
            reference,
            columns,
            sourceFile: project.sourceFile,
          },
          tolerance,
        ),
      );
    else
      checks.push(
        unavailable(
          "ingestion.warehouse-unavailable",
          "Ingestion",
          "Warehouse ingestion reconciliation",
          "The exact prepared input snapshot is unavailable, so warehouse values cannot be compared with an independent source calculation.",
        ),
      );
    checks.push(
      ...createSemanticChecks({ model, engine, reference }, tolerance),
    );
    const post = async (request: Request) => {
      try {
        const query = (await request.json()) as SemanticQuery;
        const result = await engine(
          { ...query, cache: "bypass" },
          request.signal,
        );
        return Response.json(result);
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof Error ? error.message : "Check query failed.",
          },
          { status: error instanceof HttpError ? error.status : 500 },
        );
      }
    };
    checks.push(
      ...createReportChecks({
        model,
        reports: saved.reports,
        views: saved.views,
        reference,
        absoluteTolerance: tolerance.absolute,
        relativeTolerance: tolerance.relative,
        observeReport: async (report, parameters, requestSignal) => {
          const data = await executeReportData(
            report,
            parameters,
            model!,
            requestSignal,
            post,
            true,
          );
          const preview = paginateReport(
            report.definition,
            data,
            model!,
            report.name,
          );
          const input = {
            definition: report.definition,
            data,
            model: model!,
            name: report.name,
            signal: requestSignal,
          };
          const csv = await generateReportExport("csv", input),
            xlsx = await generateReportExport("xlsx", input);
          return { data, preview, csv, xlsx };
        },
      }),
    );
    checks.push(
      ...createDashboardChecks({
        model,
        dashboards: saved.dashboards,
        views: saved.views,
        engine,
        reference,
        absoluteTolerance: tolerance.absolute,
        relativeTolerance: tolerance.relative,
        asOfDate: new Date().toISOString().slice(0, 10),
        observeDashboard: (dashboard, requestSignal) =>
          collectDashboardObservation(
            dashboard,
            model!,
            saved.views,
            engine,
            requestSignal,
            {
              lastSuccessfulRunId: load?.id ?? null,
              asOfDate: new Date().toISOString().slice(0, 10),
            },
          ),
      }),
    );
  }
  if (checks.length > 10000)
    throw new HttpError(
      413,
      "This project would produce more than 10000 checks. Reduce measure/attribute combinations or split the project; no checks were silently dropped.",
    );
  await assertUnchanged(projectId, initialSnapshot);
  return {
    checks,
    snapshot: initialSnapshot,
    modelVersion: model?.version ?? null,
  };
}
const defaults: VerificationDependencies = {
  plan: buildVerificationPlan,
  assertSnapshot: assertUnchanged,
};
export function recoverVerificationRuns(projectId: string): void {
  if (jobs.has(key(projectId))) return;
  const run = findActiveVerificationRun(projectId);
  if (!run) return;
  const pid = getVerificationOwnerPid(projectId, run.id);
  if (pid !== null && pid !== process.pid && alive(pid)) return;
  updateVerificationRun(projectId, run.id, {
    status: "failed",
    error:
      "This check run was interrupted when its Node process stopped. Its completed results were preserved; start a new run.",
    currentCheck: null,
  });
}
export async function startCheckRun(
  projectId: string,
  options: { trigger?: "manual" | "load"; sourceRunId?: string } = {},
  dependencies: VerificationDependencies = defaults,
): Promise<CheckRun> {
  requireProjectAccess(projectId, "editor");
  recoverVerificationRuns(projectId);
  if (findActiveRun(projectId))
    throw new HttpError(
      409,
      "Wait for the current load to finish before running checks.",
    );
  if (jobs.size >= 8)
    throw new HttpError(
      503,
      "The Checks worker queue is full. Wait for an active run to finish.",
    );
  const info = await verificationSnapshotInfo(projectId);
  if (options.sourceRunId && options.sourceRunId !== info.latestSourceRunId)
    throw new HttpError(
      409,
      "A newer successful load replaced this automatic check request.",
    );
  const settings = readCheckSettings(projectId),
    access = createJobAccess(projectId, "editor"),
    run = createVerificationRun(projectId, {
      sourceRunId: info.latestSourceRunId,
      modelVersion: info.modelVersion,
      trigger: options.trigger ?? "manual",
      snapshot: { version: 1, planned: false },
    }),
    controller = new AbortController();
  const job: VerificationJob = {
    projectId,
    workspaceId: access.workspaceId,
    controller,
    access,
    done: Promise.resolve(),
  };
  jobs.set(key(projectId), job);
  job.done = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
    access.run(async () => {
      const stop = access.watch(controller);
      const timeout = setTimeout(
        () =>
          controller.abort(
            new Error("Checks exceeded the 30-minute overall timeout."),
          ),
        30 * 60_000,
      );
      try {
        access.assert();
        controller.signal.throwIfAborted();
        updateVerificationRun(projectId, run.id, {
          status: "running",
          currentCheck: "Reading the independent prepared dataset reference",
        });
        const plan = await dependencies.plan(
          projectId,
          run,
          settings,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        updateVerificationRun(projectId, run.id, {
          total: plan.checks.length,
          modelVersion: plan.modelVersion ?? run.modelVersion,
        });
        getDatabase()
          .prepare(
            "UPDATE verification_runs SET snapshot_json=? WHERE project_id=? AND id=?",
          )
          .run(
            JSON.stringify({ version: 1, data: plan.snapshot ?? {} }),
            projectId,
            run.id,
          );
        await runChecks(plan.checks, {
          signal: controller.signal,
          redact: (message) =>
            redactSecrets(message, [
              process.env.DATAFORGE_SECRET ?? "",
              process.env.DATAFORGE_SMTP_PASSWORD ?? "",
            ]),
          onStart: async (check) => {
            access.assert();
            await dependencies.assertSnapshot?.(projectId, plan.snapshot);
            updateVerificationRun(projectId, run.id, {
              currentCheck: check.name,
            });
          },
          onResult: async (result) => {
            access.assert();
            await dependencies.assertSnapshot?.(projectId, plan.snapshot);
            appendVerificationResult(projectId, run.id, result);
          },
        });
        updateVerificationRun(projectId, run.id, {
          status: "succeeded",
          currentCheck: null,
        });
      } catch (error) {
        access.finish(() =>
          updateVerificationRun(projectId, run.id, {
            status: controller.signal.aborted ? "cancelled" : "failed",
            currentCheck: null,
            error: controller.signal.aborted
              ? controller.signal.reason instanceof Error
                ? controller.signal.reason.message
                : "Checks cancelled."
              : error instanceof Error
                ? error.message
                : "Checks could not complete.",
          }),
        );
      } finally {
        stop();
        clearTimeout(timeout);
        jobs.delete(key(projectId));
      }
    }),
  );
  void job.done.catch(() => {
    jobs.delete(key(projectId));
  });
  auditEvent("checks.started", "verification", run.id);
  return run;
}
export async function cancelCheckRun(
  projectId: string,
  runId: string,
): Promise<CheckRun> {
  requireProjectAccess(projectId, "editor");
  const run = getVerificationRun(projectId, runId);
  if (!["queued", "running"].includes(run.status)) return run;
  const job = jobs.get(key(projectId));
  if (!job)
    throw new HttpError(
      409,
      "This check run is active in another Node process. Cancel it in its owning process.",
    );
  job.controller.abort(new Error("Checks cancelled by the user."));
  await job.done;
  return getVerificationRun(projectId, runId);
}
export async function waitForChecks(projectId: string): Promise<void> {
  await jobs.get(key(projectId))?.done;
}
export async function maybeRunChecksAfterLoad(
  projectId: string,
  sourceRunId: string,
): Promise<void> {
  if (!readCheckSettings(projectId).autoAfterLoad) return;
  try {
    await startCheckRun(projectId, { trigger: "load", sourceRunId });
  } catch (error) {
    auditEvent("checks.auto_skipped", "project", projectId, {
      reason:
        error instanceof HttpError && error.status === 409
          ? "An active check or newer load superseded this request."
          : "Checks could not start; open Checks and retry.",
    });
  }
}
