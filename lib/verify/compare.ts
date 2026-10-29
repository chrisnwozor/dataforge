import type {
  QueryResult,
  QueryResultColumn,
  QueryValue,
} from "@/lib/semantic/query/types";
import type { CheckOutcome, ReferenceRows, ReferenceSql } from "./types";
export interface NumericComparison {
  equal: boolean;
  difference: number | null;
  tolerance: number;
}
export function compareNumbers(
  expected: number | null,
  actual: number | null,
  absolute = 0.01,
  relative = 0.000001,
): NumericComparison {
  if (expected === null || actual === null)
    return {
      equal: expected === actual,
      difference: null,
      tolerance: absolute,
    };
  if (!Number.isFinite(expected) || !Number.isFinite(actual))
    return { equal: false, difference: null, tolerance: absolute };
  const tolerance = Math.max(absolute, Math.abs(expected) * relative),
    difference = actual - expected;
  return { equal: Math.abs(difference) <= tolerance, difference, tolerance };
}
export function normalizedRows(
  rows: ReferenceRows,
  columns: QueryResultColumn[],
): Map<string, QueryValue[]> {
  const attributes = columns.filter((c) => c.role === "attribute"),
    measures = columns.filter((c) => c.role === "measure"),
    result = new Map<string, QueryValue[]>();
  for (const row of rows) {
    const key = JSON.stringify(attributes.map((c) => row[c.key] ?? null));
    if (result.has(key))
      throw new Error("A grouped result contains duplicate member tuples.");
    result.set(
      key,
      measures.map((c) => row[c.key] ?? null),
    );
  }
  return result;
}
export function compareQueryResults(
  actual: QueryResult,
  reference: ReferenceSql,
  rows: ReferenceRows,
  absolute = 0.01,
  relative = 0.000001,
): CheckOutcome {
  if (actual.truncated || rows.length > reference.limit)
    return {
      status: "skipped",
      expected: null,
      actual: null,
      difference: null,
      tolerance: absolute,
      explanation:
        "A result was truncated, so comparing a partial result would not verify correctness.",
      nextStep:
        "Reduce grouping cardinality or filters and run the check again.",
      sql: actual.sql,
      referenceSql: reference.sql,
    };
  const expectedMeasureTypes = reference.columns
    .filter((c) => c.role === "measure")
    .map((c) => c.type);
  const a = normalizedRows(actual.rows, actual.columns),
    e = normalizedRows(rows, reference.columns);
  let difference = 0,
    tolerance = absolute,
    count = 0;
  const mismatches: {
    member: string;
    expected: QueryValue[] | null;
    actual: QueryValue[] | null;
  }[] = [];
  for (const key of new Set([...a.keys(), ...e.keys()])) {
    const av = a.get(key),
      ev = e.get(key);
    let bad = !av || !ev || av.length !== ev.length;
    if (av && ev && av.length === ev.length)
      for (let i = 0; i < ev.length; i++) {
        const ex = ev[i],
          ac = av[i];
        if (ex === null || ac === null) {
          if (ex !== ac) bad = true;
          continue;
        }
        if (
          expectedMeasureTypes[i] === "number" &&
          (typeof ex === "number" ||
            (typeof ex === "string" &&
              ex.trim() !== "" &&
              !Number.isNaN(Number(ex)))) &&
          (typeof ac === "number" ||
            (typeof ac === "string" &&
              ac.trim() !== "" &&
              !Number.isNaN(Number(ac))))
        ) {
          const c = compareNumbers(Number(ex), Number(ac), absolute, relative);
          bad ||= !c.equal;
          difference = Math.max(difference, Math.abs(c.difference ?? 0));
          tolerance = Math.max(tolerance, c.tolerance);
        } else bad ||= ex !== ac;
      }
    if (bad) {
      count++;
      if (mismatches.length < 20)
        mismatches.push({
          member: key,
          expected: ev ?? null,
          actual: av ?? null,
        });
    }
  }
  const scalar =
    reference.columns.every((c) => c.role !== "attribute") &&
    expectedMeasureTypes.length === 1;
  const display = (map: Map<string, QueryValue[]>) =>
    scalar
      ? (map.get("[]")?.[0] ?? null)
      : [...map.entries()]
          .slice(0, 20)
          .map(([member, values]) => ({ member, values }));
  return {
    status: count ? "fail" : "pass",
    expected: scalar
      ? display(e)
      : count
        ? mismatches.map((m) => ({ member: m.member, values: m.expected }))
        : display(e),
    actual: scalar
      ? display(a)
      : count
        ? mismatches.map((m) => ({ member: m.member, values: m.actual }))
        : display(a),
    difference,
    tolerance,
    explanation: count
      ? `${count} member context(s) differ from the independent reference. The first ${mismatches.length} are shown; the discrepancy has not been adjusted away.`
      : `All ${e.size} member contexts match the independent reference within the stated tolerance.`,
    nextStep: count
      ? "Compare engine SQL with the reference, inspect filters, joins, Unknown members and measure definitions, then rerun."
      : "No action needed. Re-run after the next load or model edit.",
    sql: actual.sql,
    referenceSql: reference.sql,
  };
}
