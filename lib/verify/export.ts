import type { CheckRun, CheckValue } from "./types";
function cell(value: unknown): string {
  let text =
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value ?? "");
  if (typeof value !== "number" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function checkRunCsv(run: CheckRun): string {
  const header = [
    "Run ID",
    "Source load ID",
    "Check ID",
    "Area",
    "Name",
    "Status",
    "Expected",
    "Actual",
    "Difference",
    "Tolerance",
    "Elapsed ms",
    "Explanation",
    "Next step",
    "SQL used",
    "Reference SQL",
  ];
  return (
    [
      header.map(cell).join(","),
      ...run.results.map((c) =>
        [
          run.id,
          run.sourceRunId,
          c.id,
          c.area,
          c.name,
          c.status,
          c.expected,
          c.actual,
          c.difference,
          c.tolerance,
          c.elapsedMs,
          c.explanation,
          c.nextStep,
          c.sql,
          c.referenceSql ?? "",
        ]
          .map(cell)
          .join(","),
      ),
    ].join("\n") + "\n"
  );
}
export function checkRunText(run: CheckRun): string {
  const value = (v: CheckValue) =>
    typeof v === "object" ? JSON.stringify(v) : String(v ?? "NULL");
  return [
    `DataForge Checks · ${run.id}`,
    `Status: ${run.status}; started ${run.startedAt}; finished ${run.finishedAt ?? "in progress"}`,
    `Source load: ${run.sourceRunId ?? "not loaded"}; model: ${run.modelVersion ?? "unavailable"}`,
    `Pass ${run.counts.pass}, warn ${run.counts.warn}, fail ${run.counts.fail}, skipped ${run.counts.skipped}`,
    ...run.results.flatMap((c) => [
      "",
      `${c.status.toUpperCase()} · ${c.area} · ${c.name}`,
      `Expected: ${value(c.expected)}; actual: ${value(c.actual)}; difference: ${c.difference ?? "n/a"}; tolerance: ${c.tolerance}`,
      c.explanation,
      `Next step: ${c.nextStep}`,
      `SQL used:\n${c.sql || "No SQL was executed."}`,
      c.referenceSql ? `Reference SQL:\n${c.referenceSql}` : "",
    ]),
  ].join("\n");
}
