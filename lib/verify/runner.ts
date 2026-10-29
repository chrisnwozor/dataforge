import type { CheckCase, CheckResult } from "./types";
export interface RunChecksOptions {
  signal: AbortSignal;
  onStart?: (check: CheckCase, index: number) => void | Promise<void>;
  onResult?: (result: CheckResult, index: number) => void | Promise<void>;
  now?: () => number;
  redact?: (message: string) => string;
}
/** Deliberately serial: no hidden Promise.all and no SQL parallelism between checks. */
export async function runChecks(
  checks: readonly CheckCase[],
  options: RunChecksOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [],
    now = options.now ?? (() => performance.now());
  for (const [index, check] of checks.entries()) {
    options.signal.throwIfAborted();
    await options.onStart?.(check, index);
    const started = now();
    let result: CheckResult;
    try {
      const outcome = await check.run(options.signal);
      options.signal.throwIfAborted();
      result = {
        ...outcome,
        id: check.id,
        area: check.area,
        name: check.name,
        elapsedMs: Math.max(0, now() - started),
      };
    } catch (error) {
      options.signal.throwIfAborted();
      const message =
        options.redact?.(
          error instanceof Error ? error.message : String(error),
        ) ?? (error instanceof Error ? error.message : String(error));
      const preempted =
        error instanceof Error &&
        /newer main query|replaced this lower-priority|replaced this request/i.test(
          error.message,
        );
      result = {
        id: check.id,
        area: check.area,
        name: check.name,
        status: preempted ? "skipped" : "fail",
        expected: null,
        actual: null,
        difference: null,
        tolerance: 0,
        elapsedMs: Math.max(0, now() - started),
        explanation: preempted
          ? "An interactive query took priority before this check could finish. No correctness conclusion was reached."
          : `This check could not complete: ${message}`,
        nextStep: preempted
          ? "Run the check again when interactive queries have finished."
          : "Inspect the SQL and error, confirm the saved model matches the last load, and rerun this check.",
        sql:
          error && typeof error === "object" && "sql" in error
            ? String(error.sql)
            : "",
      };
    }
    results.push(result);
    await options.onResult?.(result, index);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return results;
}
