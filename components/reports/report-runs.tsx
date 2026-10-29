"use client";

import { useEffect, useState } from "react";
import { Download, History, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ReportRun } from "@/lib/server/reports";
import styles from "./report-leaves.module.css";

export function reportRunDuration(run: Pick<ReportRun, "startedAt" | "finishedAt">): string {
  const elapsed = Math.max(0, (run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt));
  return elapsed >= 60_000 ? `${Math.floor(elapsed / 60_000)}m ${Math.floor(elapsed % 60_000 / 1_000)}s` : `${(elapsed / 1_000).toFixed(1)} s`;
}
const localDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
interface Props { projectId: string; reportId: string; refreshToken?: number; onOpenRun?: (runId: string) => void }

export function ReportRuns({ projectId, reportId, refreshToken = 0, onOpenRun }: Props) {
  const [runs, setRuns] = useState<ReportRun[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}/runs`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Report history could not be loaded.");
        if (!Array.isArray(body.runs)) throw new Error("Report history returned an incomplete response.");
        if (controller.signal.aborted) return;
        setRuns(body.runs); setError("");
        if (body.runs.some((run: ReportRun) => run.status === "queued" || run.status === "running")) timer = setTimeout(() => void load(), 1_500);
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Report history could not be loaded. Try again."); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, refreshToken, attempt]);
  const mutate = async (run: ReportRun, action: "delete" | "cancel") => {
    if (action === "delete" && !window.confirm("Delete this report run and its exported files?")) return;
    setBusy(run.id); setError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(run.id)}${action === "cancel" ? "/cancel" : ""}`, { method: action === "cancel" ? "POST" : "DELETE" });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "The report run could not be updated."); }
      setAttempt((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "The report run could not be updated."); }
    finally { setBusy(""); }
  };
  return <section className={styles.root} aria-label="Report runs history">
    <div className={styles.toolbar}><div><h2>Runs history</h2><p>Previous exports, applied parameters, and execution details.</p></div><Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={13} aria-hidden="true" />Refresh history</Button></div>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {!runs ? <p className={styles.loading} role="status"><Loader2 size={14} className={styles.spin} aria-hidden="true" />Loading report history…</p> : !runs.length ? <div className={styles.empty}><History size={25} aria-hidden="true" /><h3>No report runs yet</h3><p>Run this report in Preview to create paginated output and downloadable exports.</p></div> : <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Report runs table"><table className={styles.table}>
      <thead><tr><th scope="col">Run</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Rows / pages</th><th scope="col">Parameters</th><th scope="col">Exports</th><th scope="col"><span className={styles.srOnly}>Actions</span></th></tr></thead>
      <tbody>{runs.map((run) => {
        const active = run.status === "queued" || run.status === "running";
        return <tr key={run.id}><td><button type="button" className={styles.runLink} onClick={() => onOpenRun?.(run.id)} disabled={!onOpenRun} aria-label={`Open report run ${run.id.slice(0, 8)}`}>{run.id.slice(0, 8)}</button><span className={`${styles.badge} ${styles[run.status]}`}>{active && <Loader2 size={10} className={styles.spin} aria-hidden="true" />}{run.status}</span>{run.trigger === "scheduled" && <small className={styles.muted}>Scheduled</small>}{run.error && <p className={styles.runError}>{run.error}</p>}</td>
          <td><time dateTime={run.startedAt}>{localDate(run.startedAt)}</time></td><td>{reportRunDuration(run)}</td><td>{run.rowCount.toLocaleString()} rows<br /><span className={styles.muted}>{run.pageCount.toLocaleString()} pages</span></td>
          <td>{Object.keys(run.params).length ? <details className={styles.params}><summary>{Object.keys(run.params).length} parameter{Object.keys(run.params).length === 1 ? "" : "s"}</summary><pre>{JSON.stringify(run.params, null, 2)}</pre></details> : <span className={styles.muted}>None</span>}</td>
          <td><div className={styles.exportLinks}>{(["pdf", "xlsx", "csv"] as const).filter((format) => run.filePaths[format]).map((format) => <a href={`${endpoint}/${encodeURIComponent(run.id)}/download?format=${format}`} key={format} aria-label={`Download ${format.toUpperCase()} for run ${run.id.slice(0, 8)}`}><Download size={11} aria-hidden="true" />{format.toUpperCase()}</a>)}</div></td>
          <td>{active ? <Button size="sm" variant="ghost" disabled={busy === run.id} onClick={() => void mutate(run, "cancel")} aria-label={`Cancel report run ${run.id.slice(0, 8)}`}><X size={13} aria-hidden="true" />Cancel</Button> : <Button size="icon" variant="ghost" disabled={busy === run.id} onClick={() => void mutate(run, "delete")} aria-label={`Delete report run ${run.id.slice(0, 8)}`}><Trash2 size={13} aria-hidden="true" /></Button>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
  </section>;
}
