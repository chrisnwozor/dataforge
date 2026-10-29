"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Download, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PipelineSummary, PrepareReject } from "@/lib/prepare/types";
import styles from "./sources/quality.module.css";

interface PreparationStatus {
  status: "idle" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  version: number; profiledVersion?: number | null; progress?: PipelineSummary | null; error?: string | null;
}
interface PreparationQuality {
  summary: PipelineSummary | null; rejects: PrepareReject[]; downloadUrl: string | null;
  run?: { id: string; status: string; version?: number; startedAt?: string; finishedAt?: string | null; error?: string | null };
}
interface PreparationHistoryEntry {
  id: string; version: number; status: PreparationStatus["status"]; summary: PipelineSummary | null;
  startedAt: string; finishedAt: string | null; error: string | null; warehouseRunId: string | null;
}
const statusText: Record<PreparationStatus["status"], string> = { idle: "Not prepared yet", queued: "Preparation queued", running: "Preparing and profiling", succeeded: "Prepared", failed: "Preparation stopped", cancelled: "Preparation cancelled" };
const count = (value: number | undefined) => (value ?? 0).toLocaleString("en-US");

export function PrepareQuality({ projectId, runId, compact = false }: { projectId: string; runId?: string; compact?: boolean }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/pipeline`;
  const [quality, setQuality] = useState<PreparationQuality | null>(null);
  const [status, setStatus] = useState<PreparationStatus | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [showRejects, setShowRejects] = useState(!!runId);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [qualityResponse, statusResponse] = await Promise.all([
          fetch(`${base}/quality${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`, { signal: controller.signal, cache: "no-store" }),
          fetch(`${base}/status`, { signal: controller.signal, cache: "no-store" }),
        ]);
        const [body, state] = await Promise.all([qualityResponse.json(), statusResponse.json()]);
        if (controller.signal.aborted) return;
        if (!qualityResponse.ok) throw new Error(typeof body?.error === "string" ? body.error : "Preparation quality could not be loaded.");
        const result = body as PreparationQuality;
        setQuality(result); setError("");
        if (statusResponse.ok) setStatus(state as PreparationStatus);
        const activeQuality = result.run?.status === "queued" || result.run?.status === "running";
        if (activeQuality || !runId && statusResponse.ok && ["queued", "running"].includes(state.status)) timer = setTimeout(() => { void load(); }, 1000);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Preparation quality could not be loaded."); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [base, runId, attempt]);
  const cancel = async () => {
    setCancelling(true);
    try { const response = await fetch(`${base}/cancel`, { method: "POST" }); if (!response.ok) throw new Error((await response.json()).error || "Preparation could not be cancelled."); setAttempt((value) => value + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Preparation could not be cancelled."); }
    finally { setCancelling(false); }
  };
  const active = !runId && (status?.status === "queued" || status?.status === "running");
  const summary = active ? status?.progress ?? quality?.summary : quality?.summary;
  const failed = quality?.run?.status === "failed" || !runId && status?.status === "failed";
  const failure = quality?.run?.error || (!runId ? status?.error : "");
  return <section className={`${styles.quality} ${compact ? styles.compact : ""}`} aria-label="Preparation quality">
    <div className={styles.heading}><div><ShieldCheck size={15} aria-hidden="true" /><h2>Quality</h2>{quality?.run && <span className={styles.badge}>{quality.run.status}</span>}</div><Link href={`/projects/${encodeURIComponent(projectId)}/prepare`}>Open Prepare<ArrowRight size={12} aria-hidden="true" /></Link></div>
    {error ? <div className={styles.error} role="alert">{error}<Button variant="outline" size="sm" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Retry quality</Button></div> : !quality ? <p className={styles.note} role="status">Loading preparation quality…</p> : <>
      {active && <div className={styles.progress} role="status"><Loader2 size={14} aria-hidden="true" /><span>{statusText[status!.status]} · {count(summary?.rowsRead)} rows read · {count(summary?.rowsOut)} rows out</span><Button variant="outline" size="sm" disabled={cancelling} onClick={() => { void cancel(); }}>Cancel preparation</Button></div>}
      {failed && failure && <div className={styles.error} role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{failure}</span></div>}
      {summary ? <><div className={styles.stats}><div><span>Rows read</span><strong>{count(summary.rowsRead)}</strong></div><div><span>Rows out</span><strong>{count(summary.rowsOut)}</strong></div><div><span>Rejected</span><strong>{count(summary.rowsRejected)}</strong></div></div>
        {summary.rules.length > 0 && <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Preparation quality rule counts"><table><caption className={styles.srOnly}>Quality rules and violation counts</caption><thead><tr><th scope="col">Rule</th><th scope="col">Policy</th><th scope="col">Checked</th><th scope="col">Failed</th><th scope="col">Rate</th></tr></thead><tbody>{summary.rules.map((rule, index) => <tr key={`${rule.id}:${index}`}><td>{rule.name}</td><td>{rule.severity === "reject" ? "Reject row" : rule.severity === "warn" ? "Warn only" : "Fail above threshold"}</td><td>{count(rule.checked)}</td><td>{count(rule.failed)}</td><td>{rule.ratePct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%</td></tr>)}</tbody></table></div>}
        {summary.warnings.length > 0 && <ul className={styles.warnings}>{summary.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        {compact && summary.steps.length > 0 && <details className={styles.steps}><summary>Preparation step counts</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Preparation step row counts"><table><caption className={styles.srOnly}>Rows processed by each step</caption><thead><tr><th scope="col">Step</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Rejected</th><th scope="col">Removed</th></tr></thead><tbody>{summary.steps.map((step) => <tr key={step.id}><td>{step.name}</td><td>{count(step.rowsIn)}</td><td>{count(step.rowsOut)}</td><td>{count(step.rowsRejected)}</td><td>{count(step.removed)}</td></tr>)}</tbody></table></div></details>}
        {(summary.rowsRejected > 0 || quality.rejects.length > 0) && <div className={styles.rejectActions}><Button variant="outline" size="sm" onClick={() => setShowRejects((value) => !value)} aria-expanded={showRejects}>{showRejects ? "Hide rejected rows" : "Review rejected rows"}</Button>{quality.downloadUrl && <a className="button button-outline button-sm" href={quality.downloadUrl} download><Download size={12} aria-hidden="true" />Download rejects CSV</a>}</div>}
        {showRejects && quality.rejects.length > 0 && <div className={styles.rejects}><p className={styles.note}>First {Math.min(100, quality.rejects.length)} rejected rows. Download the CSV for all recorded rejects.</p><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Prepared dataset rejected rows"><table><caption className={styles.srOnly}>Rejected source rows and their original values</caption><thead><tr><th scope="col">Source row</th><th scope="col">Step</th><th scope="col">Rule / route</th><th scope="col">Original values</th></tr></thead><tbody>{quality.rejects.slice(0, 100).map((reject, index) => <tr key={`${reject.stepId}:${reject.rowNumber}:${index}`}><td>{count(reject.rowNumber)}</td><td>{reject.stepName}</td><td>{reject.ruleName}{reject.bucket ? ` · ${reject.bucket}` : ""}</td><td className={styles.rawValues}><code tabIndex={0} role="region" aria-label={`Original values for source row ${reject.rowNumber}`}>{JSON.stringify(reject.values)}</code></td></tr>)}</tbody></table></div></div>}
      </> : <p className={styles.note}>{runId ? "No preparation quality summary was recorded for this run." : "Your original source passes through unchanged until you add preparation steps. Run Prepare to record quality counts and rejected rows."}<Link className={styles.inlineLink} href={`/projects/${encodeURIComponent(projectId)}/sources`}>Review sources<ArrowRight size={11} aria-hidden="true" /></Link></p>}
    </>}
  </section>;
}

/** Adds preparation stages without changing the legacy stage values used by other screens. */
export function PreparationStepper({ projectId, stage }: { projectId: string; stage: number }) {
  const [status, setStatus] = useState<PreparationStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/pipeline/status`, { signal: controller.signal, cache: "no-store" }); if (!response.ok) return; const value = await response.json() as PreparationStatus; if (controller.signal.aborted) return; setStatus(value); if (value.status === "queued" || value.status === "running") timer = setTimeout(() => { void load(); }, 1000); } catch { /* Other overview information remains available when preparation metadata is unavailable. */ }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId]);
  const pending = !!status && (status.status === "queued" || status.status === "running" || status.profiledVersion !== status.version);
  const current = pending ? 1 : stage === 0 ? 0 : Math.min(6, stage + 1);
  const entries = [{ label: "Sources", path: "sources" }, { label: "Prepare", path: "prepare" }, { label: "Profile", path: "profile" }, { label: "Model", path: "model" }, { label: "Generate", path: "generate" }, { label: "Run", path: "runs" }];
  return <div><ol className={styles.stepper} aria-label="Project pipeline stages">{entries.map((entry, index) => <li key={entry.path} className={`${index < current ? styles.complete : index === current ? styles.current : ""} ${index === 1 && pending && status?.status === "failed" ? styles.failed : ""}`} aria-current={index === current ? "step" : undefined}><Link href={`/projects/${encodeURIComponent(projectId)}/${entry.path}`}><span className={styles.stageNumber}>{index < current ? <Check size={12} aria-hidden="true" /> : index + 1}</span><span>{entry.label}</span></Link></li>)}</ol>{pending && <p className={styles.stepperNote}>{statusText[status!.status]}{status?.error ? ` · ${status.error}` : " · The prepared profile must finish before generating a load."}</p>}</div>;
}

export function PreparationHistory({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<PreparationHistoryEntry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/pipeline/quality`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Preparation history could not be loaded.");
        if (controller.signal.aborted) return;
        const entries = Array.isArray(body.runs) ? body.runs as PreparationHistoryEntry[] : [];
        setRuns(entries); setError("");
        if (entries.some((run) => run.status === "queued" || run.status === "running")) timer = setTimeout(() => { void load(); }, 1000);
      } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Preparation history could not be loaded."); }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, attempt]);
  return <section className={styles.quality} aria-label="Preparation run history"><div className={styles.heading}><div><ShieldCheck size={15} aria-hidden="true" /><h2>Preparation runs</h2></div><Link href={`/projects/${encodeURIComponent(projectId)}/prepare`}>Open Prepare<ArrowRight size={12} aria-hidden="true" /></Link></div>
    <p className={styles.note}>Preparation and quality checks run locally before SQL execution. Open a run to inspect its rules and rejected source rows.</p>
    {error ? <div className={styles.error} role="alert">{error}<Button variant="outline" size="sm" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Retry preparation history</Button></div> : !runs ? <p className={styles.note} role="status">Loading preparation runs…</p> : !runs.length ? <p className={styles.note}>No preparation runs yet. Add steps in Prepare and run the pipeline to record its results.</p> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Preparation run history table"><table><caption className={styles.srOnly}>Latest 100 preparation runs, including local preparations and preparations before a SQL load</caption><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Rows read</th><th scope="col">Rows out</th><th scope="col">Rejected</th></tr></thead><tbody>{runs.slice(0, 100).map((run) => <tr key={run.id}><td><button className={styles.runLink} type="button" aria-expanded={selected === run.id} aria-label={`Inspect preparation run ${run.id.slice(0, 8)} · v${run.version}`} onClick={() => setSelected((current) => current === run.id ? null : run.id)}>{run.id.slice(0, 8)}<span> · v{run.version}</span></button></td><td><span className={styles.badge}>{run.status}</span></td><td>{new Date(run.startedAt).toLocaleString()}</td><td>{run.finishedAt ? `${Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000}s` : "In progress"}</td><td>{run.summary ? count(run.summary.rowsRead) : "—"}</td><td>{run.summary ? count(run.summary.rowsOut) : "—"}</td><td>{run.summary ? count(run.summary.rowsRejected) : "—"}</td></tr>)}</tbody></table></div>}
    {selected && <PrepareQuality key={selected} projectId={projectId} runId={selected} compact />}
  </section>;
}
