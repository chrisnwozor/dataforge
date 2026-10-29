import type {
  CheckArea,
  CheckCounts,
  CheckResult,
  CheckRun,
  CheckValue,
} from "@/lib/verify/types";

export const CHECK_AREAS: readonly CheckArea[] = [
  "Ingestion",
  "Semantic",
  "Reports",
  "Dashboards",
];
export const CHECK_STATUSES = ["pass", "warn", "fail", "skipped"] as const;
export type ChecksTab = "Summary" | CheckArea;

/** UI totals are independently tallied, never inferred from the run's success flag. */
export function countCheckResults(
  results: readonly CheckResult[],
): CheckCounts {
  const counts: CheckCounts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

export function resultCountsNotice(run: CheckRun): string | null {
  const independent = countCheckResults(run.results);
  if (
    run.completed !== run.results.length ||
    CHECK_STATUSES.some((status) => independent[status] !== run.counts[status])
  ) {
    return `The saved summary does not reconcile with the ${run.results.length} detailed results. Refresh this run; if it persists, keep the downloaded report and inspect the check history storage.`;
  }
  return null;
}

export function checkRunLabel(run: CheckRun): string {
  if (run.status === "queued") return "Checks queued";
  if (run.status === "running") return "Checks running";
  if (run.status === "cancelled") return "Check run cancelled";
  if (run.status === "failed") return "Check run stopped";
  if (run.counts.fail) return "Discrepancies found";
  if (run.counts.warn) return "Checks need review";
  if (!run.counts.pass) return "No checks passed yet";
  return "Checks completed";
}

/** Numeric identifiers and integer years keep their original ungrouped form. */
export function formatCheckNumber(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Object.is(value, -0)) return "0";
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) < 0.000001 || Math.abs(value) >= 1e15)
    return value.toExponential(6);
  return new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 12,
  }).format(value);
}

export function displayCheckValue(value: CheckValue): string {
  if (value === null) return "—";
  if (typeof value === "number") return formatCheckNumber(value);
  if (typeof value === "string") return value || "(empty string)";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value, null, 2);
}

export function checkRunDuration(
  run: Pick<CheckRun, "startedAt" | "finishedAt">,
  now = Date.now(),
): number {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, end - start)
    : 0;
}

export function isCheckRunActive(
  run: Pick<CheckRun, "status"> | null | undefined,
): boolean {
  return run?.status === "running" || run?.status === "queued";
}

export function checkRunIsStale(
  run: CheckRun,
  latestSourceRunId?: string | null,
  modelVersion?: string | null,
): boolean {
  return (
    (latestSourceRunId !== undefined &&
      latestSourceRunId !== run.sourceRunId) ||
    (modelVersion !== undefined && modelVersion !== run.modelVersion)
  );
}

export function checkReportText(run: CheckRun): string {
  const summary = CHECK_STATUSES.map(
    (status) => `${status}: ${run.counts[status]}`,
  ).join(" · ");
  return [
    "DataForge data checks",
    `Run: ${run.id}`,
    `Started: ${run.startedAt}`,
    `Finished: ${run.finishedAt ?? "Still active"}`,
    `Status: ${checkRunLabel(run)}`,
    `Load: ${run.sourceRunId ?? "No successful load"}`,
    `Model: ${run.modelVersion ?? "Not available"}`,
    summary,
    ...(run.error ? [`Run error: ${run.error}`] : []),
    ...run.results.flatMap((result) => [
      "",
      `${result.status.toUpperCase()} · ${result.area} · ${result.name}`,
      `Check: ${result.id}`,
      `Expected: ${displayCheckValue(result.expected)}`,
      `Actual: ${displayCheckValue(result.actual)}`,
      `Difference: ${formatCheckNumber(result.difference)}`,
      `Tolerance: ${formatCheckNumber(result.tolerance)}`,
      `Elapsed: ${formatCheckNumber(result.elapsedMs)} ms`,
      result.explanation,
      `Next step: ${result.nextStep || "No action required."}`,
      "SQL used:",
      result.sql || "No SQL was needed for this check.",
      ...(result.referenceSql
        ? ["Independent reference SQL:", result.referenceSql]
        : []),
    ]),
  ].join("\n");
}
