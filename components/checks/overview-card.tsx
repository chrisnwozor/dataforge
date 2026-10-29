"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import type { CheckRun } from "@/lib/verify/types";
import { checksJson, type ChecksResponse } from "./api";
import {
  checkRunIsStale,
  checkRunLabel,
  isCheckRunActive,
} from "./presentation";
import styles from "./checks.module.css";

export function OverviewDataChecksCard({ projectId }: { projectId: string }) {
  const [run, setRun] = useState<CheckRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/checks`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const data = await checksJson<ChecksResponse>(endpoint, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const latest = data.runs[0] ?? null;
        setRun(latest);
        setLoaded(true);
        setError("");
        setStale(
          latest
            ? checkRunIsStale(latest, data.latestSourceRunId, data.modelVersion)
            : false,
        );
        if (data.activeRunId)
          timer = setTimeout(() => {
            void load();
          }, 1000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLoaded(true);
          setError(
            failure instanceof Error
              ? failure.message
              : "The data-check status could not be loaded.",
          );
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint]);
  return (
    <section className={styles.overviewCard} aria-label="Data checks status">
      <div className={styles.overviewHeading}>
        <h2>
          <ShieldCheck size={19} aria-hidden="true" />
          Data checks
        </h2>
        <Link
          href={`/projects/${projectId}/checks`}
          className={styles.overviewLink}
        >
          Open Checks
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
      {!loaded ? (
        <p role="status">
          <Loader2 size={16} className={styles.spinner} aria-hidden="true" />{" "}
          Loading check status…
        </p>
      ) : error ? (
        <p className={styles.error}>{error} Open Checks to retry.</p>
      ) : !run ? (
        <>
          <p>No data checks have run yet.</p>
          <p className={styles.overviewMeta}>
            Compare the prepared dataset, warehouse and saved views with
            independent references before relying on their numbers.
          </p>
        </>
      ) : (
        <>
          <p>
            <strong>{checkRunLabel(run)}</strong>
            {isCheckRunActive(run)
              ? ` · ${run.completed} of ${run.total} complete`
              : ""}
          </p>
          <div className={styles.overviewCounts}>
            <span>
              <strong>{String(run.counts.pass)}</strong> passed
            </span>
            <span>
              <strong>{String(run.counts.warn)}</strong> warnings
            </span>
            <span>
              <strong>{String(run.counts.fail)}</strong> failed
            </span>
            <span>
              <strong>{String(run.counts.skipped)}</strong> skipped
            </span>
          </div>
          <p className={styles.overviewMeta}>
            Last run:{" "}
            <time dateTime={run.startedAt}>
              {new Date(run.startedAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          </p>
          {stale ? (
            <p className={styles.warning}>
              These results describe an earlier load or model. Run checks again
              for the current project.
            </p>
          ) : (
            <p className={styles.overviewMeta}>
              Results describe the load and model snapshot recorded with that
              run. Skipped checks are not proof of correctness.
            </p>
          )}
        </>
      )}
    </section>
  );
}
