import { bankflow } from "@/content/bankflow";
import styles from "./bankflow.module.css";

export function BankFlowMetrics({ note = true }: { note?: boolean }) {
  return (
    <div>
      <dl className={styles.metrics}>
        {bankflow.metrics.map((metric) => (
          <div className={styles.metric} key={metric.id}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className={styles.metricNote}>{bankflow.metricsNote}</p>}
    </div>
  );
}
