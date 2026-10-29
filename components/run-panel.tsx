"use client";

import { useEffect, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Clock3,
  Loader2,
  Minus,
  Pause,
  Play,
  RefreshCw,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import {
  isTerminalRun,
  type RunRecord,
  type RunStatus,
  type RunStepStatus,
} from "@/lib/runner/types";
import { Button } from "./ui/button";
import { DataTable } from "./shared";
import { useRunLive } from "./use-run-live";
import { number } from "@/lib/utils";
import { PrepareQuality } from "./prepare-quality";

export function runStatusLabel(status: RunStepStatus): string {
  return {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    skipped: "Skipped",
  }[status];
}
export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`run-status-badge run-status-${status}`}>
      <span />
      {runStatusLabel(status)}
    </span>
  );
}
export function runTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
function logTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
export function runDuration(
  start: string | null,
  finish: string | null,
  now?: number | null,
): string {
  if (!start || (!finish && !now)) return "—";
  const seconds = Math.max(
    0,
    Math.round(
      ((finish ? Date.parse(finish) : now!) - Date.parse(start)) / 1000,
    ),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function StepIcon({ status }: { status: RunStepStatus }) {
  if (status === "running")
    return <Loader2 size={14} className="animate-spin" />;
  if (status === "succeeded") return <CheckCircle2 size={14} />;
  if (status === "failed") return <XCircle size={14} />;
  if (status === "cancelled") return <Ban size={14} />;
  if (status === "skipped") return <Minus size={14} />;
  return <Clock3 size={14} />;
}

export function RunPanel({
  projectId,
  runId,
  onClose,
  onRunChange,
}: {
  projectId: string;
  runId: string;
  onClose: () => void;
  onRunChange?: (run: RunRecord) => void;
}) {
  const { detail, error, streaming, refresh } = useRunLive(
    projectId,
    runId,
    onRunChange,
  );
  const [paused, setPaused] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [clock, setClock] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const status = detail?.run.status;
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const element = dialog.current;
    element?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = oldOverflow;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (status && isTerminalRun(status)) return;
    const interval = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [status]);
  useEffect(() => {
    if (!paused && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [detail?.logs.length, paused]);
  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setCancelError("");
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      );
      const value = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          value?.error || "The run could not be cancelled. Try again.",
        );
      await refresh();
    } catch (failure) {
      setCancelError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Try again.",
      );
      await refresh();
    } finally {
      setCancelling(false);
    }
  }
  const active = detail ? !isTerminalRun(detail.run.status) : false;
  return (
    <dialog
      ref={dialog}
      className="run-detail-sheet"
      aria-labelledby="run-panel-title"
      onCancel={() => close.current()}
    >
      <div className="run-sheet-header">
        <div>
          <div className="eyebrow">RUN DETAILS</div>
          <h2 id="run-panel-title" className="mono">
            {runId}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close run details"
        >
          <X size={18} />
        </Button>
      </div>
      {error && (
        <div className="run-panel-error" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshCw size={12} />
            Retry
          </Button>
        </div>
      )}
      {!detail ? (
        <p className="run-loading" role="status">
          <Loader2 size={15} className="animate-spin" />
          Loading run…
        </p>
      ) : (
        <>
          <div className="run-panel-status">
            <RunStatusBadge status={detail.run.status} />
            <span className="small muted">
              {active
                ? streaming
                  ? "Live updates"
                  : "Polling for updates"
                : "Run finished"}
            </span>
          </div>
          <div className="run-meta-grid">
            <div>
              <span>Started</span>
              <strong>{runTime(detail.run.startedAt)}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong className="mono">
                {runDuration(
                  detail.run.startedAt,
                  detail.run.finishedAt,
                  clock,
                )}
              </strong>
            </div>
            <div>
              <span>Mode</span>
              <strong>
                {detail.run.mode === "incremental"
                  ? "Incremental"
                  : "Full refresh"}
              </strong>
            </div>
            <div>
              <span>Database</span>
              <strong className="mono">{detail.run.options.db}</strong>
            </div>
          </div>
          <section className="run-steps" aria-labelledby="run-steps-title">
            <h3 id="run-steps-title">Execution steps</h3>
            <ol>
              {detail.steps.map((step) => (
                <li
                  key={step.ordinal}
                  className={`run-step run-step-${step.status}`}
                >
                  <StepIcon status={step.status} />
                  <span className="run-step-file mono">
                    {step.file}
                    <small>{step.message}</small>
                  </span>
                  <span className="run-step-state">
                    {runStatusLabel(step.status)}
                    <small className="mono">
                      {runDuration(step.startedAt, step.finishedAt, clock)}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          {detail.run.errorMessage && (
            <div className="run-panel-error" role="alert">
              <strong>
                {detail.run.errorFile
                  ? `${detail.run.errorFile}${detail.run.errorBatch ? ` · batch ${detail.run.errorBatch}` : ""}`
                  : "Run failed"}
              </strong>
              <span>
                {detail.run.errorNumber !== null
                  ? `SQL ${detail.run.errorNumber}${detail.run.errorLine !== null ? `, line ${detail.run.errorLine}` : ""}: `
                  : ""}
                {detail.run.errorMessage}
              </span>
            </div>
          )}
          <div className="run-log-heading">
            <h3>
              <Terminal size={14} />
              Execution logs
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPaused((value) => !value)}
              aria-pressed={paused}
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {paused ? "Resume auto-scroll" : "Pause auto-scroll"}
            </Button>
          </div>
          <div
            ref={log}
            className="log-viewer run-live-logs"
            tabIndex={0}
            role="region"
            aria-label="Execution logs"
          >
            {detail.logs.length ? (
              detail.logs.map((line) => (
                <div
                  key={line.id}
                  className={`log-line run-log-${line.level.toLowerCase()}`}
                >
                  <time dateTime={line.ts} title={runTime(line.ts)}>
                    {logTime(line.ts)}
                  </time>
                  <span>[{line.level}]</span>
                  <span>{line.message}</span>
                </div>
              ))
            ) : (
              <p className="muted">Waiting for the first log entry…</p>
            )}
          </div>
          {cancelError && (
            <p className="inline-error" role="alert">
              {cancelError}
            </p>
          )}
          {active ? (
            <div className="run-panel-actions">
              <span className="help-text">
                Completed scripts remain committed. Cancelling rolls back the
                current open transaction.
              </span>
              <Button
                variant="outline"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Ban size={12} />
                )}
                {cancelling ? "Cancelling…" : "Cancel run"}
              </Button>
            </div>
          ) : (
            <section
              className="panel run-final-summary"
              aria-labelledby="run-summary-title"
            >
              <div className="panel-header">
                <h3 id="run-summary-title">Run summary</h3>
              </div>
              <div className="panel-body">
                <div>
                  <span>Rows staged</span>
                  <strong>{number(detail.run.rowsStaged)}</strong>
                </div>
                <div>
                  <span>Rows loaded</span>
                  <strong>{number(detail.run.rowsLoaded)}</strong>
                </div>
                <div>
                  <span>Rows rejected</span>
                  <strong>{number(detail.run.rowsRejected)}</strong>
                </div>
                <div>
                  <span>Duration</span>
                  <strong>
                    {runDuration(detail.run.startedAt, detail.run.finishedAt)}
                  </strong>
                </div>
              </div>
            </section>
          )}
          {detail.run.prepareSummary && <PrepareQuality projectId={projectId} runId={runId} compact />}
          <section
            className="run-rejections"
            aria-labelledby="run-rejections-title"
          >
            <h3 id="run-rejections-title">
              Rejected rows{" "}
              <span className="count">{detail.run.rowsRejected}</span>
            </h3>
            {detail.rejected.length ? (
              <>
                <DataTable>
                  <thead>
                    <tr>
                      <th>Source row</th>
                      <th>Reason</th>
                      <th>Source values</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rejected.map((row, index) => (
                      <tr key={`${row.sourceRowNumber}-${index}`}>
                        <td className="mono">{row.sourceRowNumber}</td>
                        <td>{row.reason}</td>
                        <td>
                          <code className="run-reject-json">{row.rawJson}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
                <p className="help-text">
                  Showing the first {detail.rejected.length} rejected rows.
                </p>
              </>
            ) : (
              <p className="help-text">
                {active
                  ? "Rejected rows appear when execution finishes."
                  : detail.run.status === "succeeded"
                    ? "No rejected rows. All loaded rows passed validation."
                    : "No rejected-row preview was recorded for this run."}
              </p>
            )}
          </section>
        </>
      )}
    </dialog>
  );
}
