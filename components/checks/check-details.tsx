import {
  CircleCheck,
  CircleDashed,
  OctagonX,
  TriangleAlert,
} from "lucide-react";
import type { CheckResult, CheckStatus } from "@/lib/verify/types";
import { displayCheckValue, formatCheckNumber } from "./presentation";
import styles from "./checks.module.css";

const labels: Record<CheckStatus, string> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  skipped: "Skipped",
};
const icons = {
  pass: CircleCheck,
  warn: TriangleAlert,
  fail: OctagonX,
  skipped: CircleDashed,
};
export function CheckStatusBadge({ status }: { status: CheckStatus }) {
  const Icon = icons[status];
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      <Icon size={15} aria-hidden="true" />
      {labels[status]}
    </span>
  );
}

export function CheckDetails({ result }: { result: CheckResult }) {
  return (
    <details
      className={`${styles.check} ${result.status === "fail" ? styles.failedCheck : ""}`}
    >
      <summary>
        <CheckStatusBadge status={result.status} />
        <span className={styles.checkName}>
          {result.name}
          <small>
            {result.area} · {formatCheckNumber(result.elapsedMs)} ms
          </small>
        </span>
        <span className={styles.expandHint}>Details</span>
      </summary>
      <div className={styles.detailBody}>
        <p>{result.explanation}</p>
        <div className={styles.values}>
          <section aria-label="Expected value">
            <h3>Expected</h3>
            <pre
              tabIndex={0}
              role="region"
              aria-label="Expected value details"
              title={
                typeof result.expected === "number"
                  ? String(result.expected)
                  : undefined
              }
            >
              {displayCheckValue(result.expected)}
            </pre>
          </section>
          <section aria-label="Actual value">
            <h3>Actual</h3>
            <pre
              tabIndex={0}
              role="region"
              aria-label="Actual value details"
              title={
                typeof result.actual === "number"
                  ? String(result.actual)
                  : undefined
              }
            >
              {displayCheckValue(result.actual)}
            </pre>
          </section>
        </div>
        <dl className={styles.metrics}>
          <div>
            <dt>Difference</dt>
            <dd title={String(result.difference)}>
              {formatCheckNumber(result.difference)}
            </dd>
          </div>
          <div>
            <dt>Tolerance</dt>
            <dd title={String(result.tolerance)}>
              {formatCheckNumber(result.tolerance)}
            </dd>
          </div>
          <div>
            <dt>Elapsed</dt>
            <dd>{formatCheckNumber(result.elapsedMs)} ms</dd>
          </div>
        </dl>
        <p
          className={
            result.status === "fail" || result.status === "warn"
              ? styles.nextStep
              : undefined
          }
        >
          <strong>Next step: </strong>
          {result.nextStep ||
            (result.status === "fail"
              ? "Inspect the expected and actual values and the independent SQL, then rerun after investigating the mismatch."
              : result.status === "skipped"
                ? "Complete this check’s prerequisites, then rerun it."
                : result.status === "warn"
                  ? "Review this warning before relying on the result."
                  : "No action required.")}
        </p>
        <details className={styles.sql}>
          <summary>SQL used</summary>
          <pre tabIndex={0} role="region" aria-label="SQL used by this check">
            {result.sql || "No SQL was needed for this check."}
          </pre>
        </details>
        {result.referenceSql && (
          <details className={styles.sql}>
            <summary>Independent reference SQL</summary>
            <pre
              tabIndex={0}
              role="region"
              aria-label="Independent reference SQL text"
            >
              {result.referenceSql}
            </pre>
          </details>
        )}
        <p className={styles.caption}>
          Check ID: <span className={styles.mono}>{result.id}</span>
        </p>
      </div>
    </details>
  );
}
