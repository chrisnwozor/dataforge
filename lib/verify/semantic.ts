import { parse } from "@/lib/semantic/expr/parser";
import type { Expr } from "@/lib/semantic/expr/types";
import type { SemanticModel, SemanticMeasure } from "@/lib/semantic/types";
import type {
  AttributeRef,
  QueryResult,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import { compareNumbers, compareQueryResults, normalizedRows } from "./compare";
import {
  buildReferenceQuery,
  classifyMeasure,
  isAdditiveMeasure,
  referenceMeasure,
  UnsupportedReferenceError,
} from "./reference";
import type { CheckCase, CheckOutcome, SemanticCheckInput } from "./types";

const key = (value: AttributeRef) =>
  JSON.stringify([value.table, value.column]);
const number = (value: QueryValue | undefined): number | null =>
  value === null || value === undefined
    ? null
    : typeof value === "number"
      ? value
      : typeof value === "string" &&
          value.trim() !== "" &&
          Number.isFinite(Number(value))
        ? Number(value)
        : null;
const baseQuery = (
  measure: string,
  rows: AttributeRef[] = [],
): SemanticQuery => ({
  measures: [measure],
  rows,
  filters: [],
  orderBy: [],
  limit: 50000,
  hideUnknown: false,
  cache: "bypass",
});
const value = (result: QueryResult) => {
  const column = result.columns.find((c) => c.role === "measure");
  return column ? number(result.rows[0]?.[column.key]) : null;
};
const noAction =
  "No action needed. Run checks again after a load or semantic-model change.";
function skipped(
  explanation: string,
  sql = "",
  referenceSql?: string,
): CheckOutcome {
  return {
    status: "skipped",
    expected: null,
    actual: null,
    difference: null,
    tolerance: 0,
    explanation,
    nextStep:
      "Add an independent oracle for this expression/context, or reduce the result cardinality, then run again.",
    sql,
    ...(referenceSql ? { referenceSql } : {}),
  };
}
function unavailable(
  error: unknown,
  sql: string,
  referenceSql?: string,
): CheckOutcome {
  if (error instanceof UnsupportedReferenceError)
    return skipped(error.message, sql, referenceSql);
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : null;
  if (status === 499)
    return skipped(
      "This low-priority check was interrupted by a newer interactive request. No numerical assertion was made.",
      sql,
      referenceSql,
    );
  const message =
    error instanceof Error
      ? error.message
      : "The engine or reference query could not complete.";
  return {
    status: "fail",
    expected: null,
    actual: null,
    difference: null,
    tolerance: 0,
    explanation: `Verification could not complete: ${message} This is an execution failure, not a numerical pass.`,
    nextStep:
      "Review the recorded SQL and connection/schema readiness, resolve the execution error, and rerun this check.",
    sql,
    ...(referenceSql ? { referenceSql } : {}),
  };
}
function withErrorDetails(
  task: (
    signal: AbortSignal,
    record: (sql: string, referenceSql?: string) => void,
  ) => Promise<CheckOutcome>,
): CheckCase["run"] {
  return async (signal) => {
    let sql = "",
      referenceSql: string | undefined;
    try {
      signal.throwIfAborted();
      return await task(signal, (a, b) => {
        sql = a;
        if (b) referenceSql = b;
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const e = error as { sql?: string; referenceSql?: string } | null;
      return unavailable(
        error,
        sql || e?.sql || "",
        e?.referenceSql || referenceSql,
      );
    }
  };
}
/** Attributes removed by ALL must be the grouped axis before distribution sums
 * can legitimately be expected to equal 1; unrelated axes must never be summed. */
export function clearedMeasureAttributes(
  model: SemanticModel,
  name: string,
): AttributeRef[] {
  const refs = new Map<string, AttributeRef>(),
    path = new Set<string>();
  let visits = 0;
  const walk = (node: Expr) => {
    if (++visits > 2048)
      throw new UnsupportedReferenceError(
        "Measure expansion exceeds the independent inspection budget.",
      );
    if (node.kind === "measure") {
      const m = referenceMeasure(model, node.name);
      if (path.has(m.id))
        throw new UnsupportedReferenceError("Measure reference cycle.");
      path.add(m.id);
      try {
        walk(parse(m.expression));
      } finally {
        path.delete(m.id);
      }
      return;
    }
    if (node.kind === "call") {
      if (node.name === "ALL" && node.args[0]?.kind === "column") {
        const c = node.args[0],
          table = model.tables.find((t) =>
            [t.id, t.name, t.sqlName].some(
              (v) => v.toLowerCase() === c.tableName.toLowerCase(),
            ),
          ),
          column = table?.columns.find((a) =>
            [a.id, a.name, a.sqlName].some(
              (v) => v.toLowerCase() === c.columnName.toLowerCase(),
            ),
          );
        if (table && column) {
          const ref = { table: table.id, column: column.id };
          refs.set(key(ref), ref);
        }
      }
      node.args.forEach(walk);
    } else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    } else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "in") {
      walk(node.expression);
      node.values.forEach(walk);
    }
  };
  walk(parse(referenceMeasure(model, name).expression));
  return [...refs.values()];
}
/** A distribution assertion is valid only for the same additive numerator and
 * ALL-only denominator. Cross-measure ratios and average/distinct-count ratios
 * are reconciled against SQL, but are not falsely required to sum to 100%. */
function isPercentDistribution(model: SemanticModel, name: string): boolean {
  let visits = 0;
  const expand = (node: Expr, path = new Set<string>()): Expr => {
    if (++visits > 2048)
      throw new UnsupportedReferenceError(
        "Distribution inspection exceeds its budget.",
      );
    if (node.kind === "measure") {
      const m = referenceMeasure(model, node.name);
      if (path.has(m.id))
        throw new UnsupportedReferenceError("Measure reference cycle.");
      const next = new Set(path);
      next.add(m.id);
      return expand(parse(m.expression), next);
    }
    if (node.kind === "call")
      return { ...node, args: node.args.map((a) => expand(a, path)) };
    if (node.kind === "binary")
      return {
        ...node,
        left: expand(node.left, path),
        right: expand(node.right, path),
      };
    if (node.kind === "unary")
      return { ...node, operand: expand(node.operand, path) };
    return node;
  };
  const canonical = (node: Expr): string =>
    JSON.stringify(node, (k, v) =>
      k === "pos" || k === "end"
        ? undefined
        : typeof v === "string"
          ? v.toLowerCase()
          : v,
    );
  try {
    const root = expand(parse(referenceMeasure(model, name).expression));
    if (root.kind !== "call" || root.name !== "DIVIDE" || root.args.length < 2)
      return false;
    const numerator = root.args[0],
      denominator = root.args[1];
    if (
      numerator.kind !== "call" ||
      !["SUM", "COUNT", "COUNT_BIG"].includes(numerator.name) ||
      denominator.kind !== "call" ||
      denominator.name !== "CALCULATE" ||
      denominator.args.length < 2
    )
      return false;
    if (canonical(numerator) !== canonical(denominator.args[0])) return false;
    if (
      !denominator.args
        .slice(1)
        .every(
          (f) =>
            f.kind === "call" &&
            f.name === "ALL" &&
            f.args.length === 1 &&
            f.args[0].kind === "column",
        )
    )
      return false;
    const alternate = root.args[2];
    return (
      !alternate ||
      (alternate.kind === "literal" &&
        (alternate.value === null || alternate.value === 0))
    );
  } catch {
    return false;
  }
}

function numericOutcome(
  expected: number | null,
  actual: number | null,
  absolute: number,
  relative: number,
  explanation: string,
  sql: string,
  referenceSql?: string,
): CheckOutcome {
  const comparison = compareNumbers(expected, actual, absolute, relative);
  return {
    status: comparison.equal ? "pass" : "fail",
    expected,
    actual,
    difference: comparison.difference,
    tolerance: comparison.tolerance,
    explanation: comparison.equal
      ? `${explanation} Values match within tolerance.`
      : `${explanation} The difference exceeds tolerance; it has not been corrected or hidden.`,
    nextStep: comparison.equal
      ? noAction
      : "Inspect the independent reference, filter context, Unknown members and measure definition before using this result.",
    sql,
    ...(referenceSql ? { referenceSql } : {}),
  };
}
function sumResult(result: QueryResult, grand: number | null): number | null {
  const c = result.columns.find((c) => c.role === "measure");
  if (!c) throw new Error("The semantic response contains no measure column.");
  const values = result.rows
    .map((r) => number(r[c.key]))
    .filter((n): n is number => n !== null);
  return values.length
    ? values.reduce((a, b) => a + b, 0)
    : grand === null
      ? null
      : 0;
}

export function createSemanticChecks(
  input: SemanticCheckInput,
  tolerances = { absolute: 0.01, relative: 0.000001 },
): CheckCase[] {
  const { model, engine, reference } = input,
    checks: CheckCase[] = [];
  const limit = Math.min(50, Math.max(1, input.attributeLimit ?? 50));
  const attributes = model.tables
    .filter((t) => t.kind === "dimension")
    .flatMap((table) =>
      table.columns
        .filter((c) => c.role === "attribute")
        .map((column) => ({
          ref: { table: table.id, column: column.id },
          label: `${table.name}[${column.name}]`,
          count: column.distinctCount,
        })),
    );
  const addComparison = (
    id: string,
    name: string,
    measure: SemanticMeasure,
    query: SemanticQuery,
    explanation: string,
  ) => {
    let ratio = false;
    try {
      ratio = classifyMeasure(model, measure.id).ratio;
    } catch {
      /* The build step will produce a truthful unsupported result. */
    }
    const absolute =
      measure.format === "percent" || ratio
        ? Math.min(tolerances.absolute, 0.000001)
        : tolerances.absolute;
    checks.push({
      id,
      area: "Semantic",
      name,
      run: withErrorDetails(async (signal, record) => {
        const compiled = buildReferenceQuery(model, query);
        record("", compiled.sql);
        const actual = await engine(query, signal);
        record(actual.sql, compiled.sql);
        const expected = await reference(compiled, signal);
        const result = compareQueryResults(
          actual,
          compiled,
          expected,
          absolute,
          tolerances.relative,
        );
        return {
          ...result,
          explanation: `${explanation} ${result.explanation}`,
        };
      }),
    });
  };
  for (const measure of model.measures) {
    addComparison(
      `semantic-total:${measure.id}`,
      `${measure.name} · grand total`,
      measure,
      baseQuery(measure.id),
      "The semantic result is compared with separately resolved, hand-built aggregate SQL over the saved physical model.",
    );
    let classification: ReturnType<typeof classifyMeasure>;
    try {
      classification = classifyMeasure(model, measure.id);
    } catch (error) {
      checks.push({
        id: `semantic-definition:${measure.id}`,
        area: "Semantic",
        name: `${measure.name} · independent definition`,
        run: async () =>
          skipped(
            error instanceof Error
              ? error.message
              : "The measure definition could not be inspected.",
          ),
      });
      continue;
    }
    for (const attribute of attributes) {
      const id = `semantic-group:${measure.id}:${attribute.ref.table}:${attribute.ref.column}`;
      if (attribute.count === undefined || attribute.count > limit) {
        checks.push({
          id,
          area: "Semantic",
          name: `${measure.name} by ${attribute.label}`,
          run: async () =>
            skipped(
              attribute.count === undefined
                ? `${attribute.label} has no retained cardinality estimate. A full unbounded grouping is not run implicitly.`
                : `${attribute.label} has ${attribute.count} distinct values, above the ${limit}-member single-attribute check budget.`,
            ),
        });
        continue;
      }
      const query = baseQuery(measure.id, [attribute.ref]);
      addComparison(
        id,
        `${measure.name} by ${attribute.label}`,
        measure,
        query,
        "Each complete member context is compared independently; rows are aligned by member value rather than row order.",
      );
      if (isAdditiveMeasure(model, measure.id))
        checks.push({
          id: `semantic-additive:${measure.id}:${attribute.ref.table}:${attribute.ref.column}`,
          area: "Semantic",
          name: `${measure.name} · groups reconcile to total by ${attribute.label}`,
          run: withErrorDetails(async (signal, record) => {
            const compiled = buildReferenceQuery(model, baseQuery(measure.id));
            record("", compiled.sql);
            const grouped = await engine(query, signal);
            record(grouped.sql, compiled.sql);
            if (grouped.truncated)
              return skipped(
                "The grouped response was truncated; summing it would not verify a complete partition.",
                grouped.sql,
                compiled.sql,
              );
            const grand = await engine(baseQuery(measure.id), signal);
            record(
              `${grouped.sql}\n-- Grand total engine query\n${grand.sql}`,
              compiled.sql,
            );
            const expected = await reference(compiled, signal),
              referenceColumn = compiled.columns.find(
                (c) => c.role === "measure",
              )!;
            const target = number(expected[0]?.[referenceColumn.key]);
            const grandCheck = compareNumbers(
              target,
              value(grand),
              tolerances.absolute,
              tolerances.relative,
            );
            if (!grandCheck.equal)
              return numericOutcome(
                target,
                value(grand),
                tolerances.absolute,
                tolerances.relative,
                "The engine grand total differs from the independent aggregate before grouping is reconciled.",
                grand.sql,
                compiled.sql,
              );
            return numericOutcome(
              target,
              sumResult(grouped, target),
              tolerances.absolute,
              tolerances.relative,
              "The independently computed grand total equals the sum of all engine member groups, including Unknown members.",
              `${grouped.sql}\n-- Grand total engine query\n${grand.sql}`,
              compiled.sql,
            );
          }),
        });
      if (
        measure.format === "percent" &&
        classification.ratio &&
        classification.percentOfTotal &&
        isPercentDistribution(model, measure.id)
      ) {
        const cleared = clearedMeasureAttributes(model, measure.id);
        if (cleared.some((ref) => key(ref) === key(attribute.ref)))
          checks.push({
            id: `semantic-percent:${measure.id}:${attribute.ref.table}:${attribute.ref.column}`,
            area: "Semantic",
            name: `${measure.name} · ${attribute.label} distribution totals 100%`,
            run: withErrorDetails(async (signal, record) => {
              const compiled = buildReferenceQuery(model, query);
              record("", compiled.sql);
              const actual = await engine(query, signal);
              record(actual.sql, compiled.sql);
              const expected = await reference(compiled, signal),
                compare = compareQueryResults(
                  actual,
                  compiled,
                  expected,
                  Math.min(tolerances.absolute, 0.000001),
                  tolerances.relative,
                );
              if (compare.status !== "pass") return compare;
              if (!actual.rows.length)
                return skipped(
                  "The distribution has no rows, so a 100% partition cannot be asserted.",
                  actual.sql,
                  compiled.sql,
                );
              const measureColumn = actual.columns.find(
                (c) => c.role === "measure",
              );
              if (
                measureColumn &&
                actual.rows.every(
                  (row) =>
                    number(row[measureColumn.key]) === null ||
                    number(row[measureColumn.key]) === 0,
                )
              )
                return skipped(
                  "The independent distribution is undefined because its denominator is zero or NULL. No 100% assertion is made.",
                  actual.sql,
                  compiled.sql,
                );
              const total = sumResult(actual, 0);
              return numericOutcome(
                1,
                total,
                Math.min(tolerances.absolute, 0.000001),
                tolerances.relative,
                "The complete cleared-attribute distribution must sum to 100% (the raw engine value 1).",
                actual.sql,
                compiled.sql,
              );
            }),
          });
      }
    }
    if (classification.ratio)
      addComparison(
        `semantic-ratio:${measure.id}`,
        `${measure.name} · recompute ratio from independent parts`,
        measure,
        baseQuery(measure.id),
        "Numerator and denominator are expanded independently into physical aggregates, then divided with an explicit zero-denominator policy.",
      );
    if (classification.time && model.date) {
      const table = model.tables.find((t) => t.id === model.date!.tableId),
        year = table?.columns.find((c) => c.name.toLowerCase() === "year"),
        month = table?.columns.find((c) => c.name.toLowerCase() === "month");
      if (year)
        addComparison(
          `semantic-time:${measure.id}:year`,
          `${measure.name} · independent calendar window by year`,
          measure,
          baseQuery(measure.id, [{ table: table!.id, column: year.id }]),
          "The reference derives complete Year/Month/Quarter boundaries from calendar members, separately groups daily facts, and uses SQL window functions. It does not infer prior-period bounds from dates that happen to have sales.",
        );
      if (year && month)
        addComparison(
          `semantic-time:${measure.id}:month`,
          `${measure.name} · independent calendar window by year and month`,
          measure,
          baseQuery(measure.id, [
            { table: table!.id, column: year.id },
            { table: table!.id, column: month.id },
          ]),
          "Year/month windows and prior-period offsets are calculated without the semantic compiler.",
        );
    }
  }
  for (const hierarchy of model.hierarchies)
    for (let depth = 1; depth < hierarchy.levels.length; depth++)
      for (const measure of model.measures.filter((m) =>
        isAdditiveMeasure(model, m.id),
      )) {
        const parent = hierarchy.levels
            .slice(0, depth)
            .map((column) => ({ table: hierarchy.tableId, column })),
          child = hierarchy.levels
            .slice(0, depth + 1)
            .map((column) => ({ table: hierarchy.tableId, column }));
        checks.push({
          id: `semantic-hierarchy:${hierarchy.id}:${depth}:${measure.id}`,
          area: "Semantic",
          name: `${hierarchy.name} · ${measure.name} children reconcile at level ${depth + 1}`,
          run: withErrorDetails(async (signal, record) => {
            const parentReference = buildReferenceQuery(
                model,
                baseQuery(measure.id, parent),
              ),
              childReference = buildReferenceQuery(
                model,
                baseQuery(measure.id, child),
              );
            record(
              "",
              `${parentReference.sql}\n-- Child reference\n${childReference.sql}`,
            );
            const actualParent = await engine(
                baseQuery(measure.id, parent),
                signal,
              ),
              actualChild = await engine(baseQuery(measure.id, child), signal);
            record(
              `${actualParent.sql}\n-- Child engine query\n${actualChild.sql}`,
            );
            const expectedParent = await reference(parentReference, signal),
              expectedChild = await reference(childReference, signal);
            const pc = compareQueryResults(
              actualParent,
              parentReference,
              expectedParent,
              tolerances.absolute,
              tolerances.relative,
            );
            if (pc.status !== "pass")
              return {
                ...pc,
                explanation: `Parent contexts failed independent reconciliation. ${pc.explanation}`,
              };
            const cc = compareQueryResults(
              actualChild,
              childReference,
              expectedChild,
              tolerances.absolute,
              tolerances.relative,
            );
            if (cc.status !== "pass")
              return {
                ...cc,
                explanation: `Child contexts failed independent reconciliation. ${cc.explanation}`,
              };
            const childAttributes = actualChild.columns.filter(
                (c) => c.role === "attribute",
              ),
              measureColumn = actualChild.columns.find(
                (c) => c.role === "measure",
              )!,
              aggregated = new Map<string, number | null>();
            for (const row of actualChild.rows) {
              const member = JSON.stringify(
                  childAttributes
                    .slice(0, depth)
                    .map((c) => row[c.key] ?? null),
                ),
                n = number(row[measureColumn.key]);
              if (!aggregated.has(member)) aggregated.set(member, null);
              if (n !== null)
                aggregated.set(member, (aggregated.get(member) ?? 0) + n);
            }
            const parentRows = normalizedRows(
              expectedParent,
              parentReference.columns,
            );
            let failures = 0,
              maxDifference = 0,
              maxTolerance = tolerances.absolute;
            for (const member of new Set([
              ...parentRows.keys(),
              ...aggregated.keys(),
            ])) {
              const expected = number(parentRows.get(member)?.[0]),
                actual = aggregated.get(member);
              if (actual === undefined) {
                failures++;
                continue;
              }
              const comparison = compareNumbers(
                expected,
                actual,
                tolerances.absolute,
                tolerances.relative,
              );
              if (!comparison.equal) failures++;
              maxDifference = Math.max(
                maxDifference,
                Math.abs(comparison.difference ?? 0),
              );
              maxTolerance = Math.max(maxTolerance, comparison.tolerance);
            }
            return {
              status: failures ? "fail" : "pass",
              expected: parentRows.size,
              actual: aggregated.size,
              difference: maxDifference,
              tolerance: maxTolerance,
              explanation: failures
                ? `${failures} hierarchy parent context(s) do not equal the sum of their independently reconciled children.`
                : `All ${parentRows.size} hierarchy parents equal the sum of their children, and both levels match independent SQL.`,
              nextStep: failures
                ? "Check hierarchy relationships and duplicate dimension members; inspect the child and parent queries."
                : noAction,
              sql: `${actualParent.sql}\n-- Child engine query\n${actualChild.sql}`,
              referenceSql: `${parentReference.sql}\n-- Child reference\n${childReference.sql}`,
            };
          }),
        });
      }
  return checks;
}
