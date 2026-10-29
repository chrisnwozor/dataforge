"use client";
import {canEdit,useWorkspaceRole} from "@/components/auth/provider";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, FileBarChart2, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createEmptyReport, type SavedReport } from "@/lib/reports/schema";
import { generateStarterReport } from "@/lib/reports/starter";
import type { SemanticModel } from "@/lib/semantic/types";
import { reportBody, reportJson } from "./api";
import styles from "./reports.module.css";

type ListReport = SavedReport & { lastRun?: { status: string; startedAt: string } | null; scheduleCount?: number };

export function ReportList({ projectId }: { projectId: string }) {
  const router = useRouter();
  const editable=canEdit(useWorkspaceRole());
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/reports`;
  const [reports, setReports] = useState<ListReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    reportJson<{ reports: ListReport[] }>(endpoint, { signal: controller.signal }).then((body) => setReports(body.reports)).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Reports could not be loaded."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const create = async (starter: boolean) => {
    setBusy(true); setError("");
    try {
      const document = starter ? generateStarterReport(await reportJson<SemanticModel>(`/api/projects/${encodeURIComponent(projectId)}/semantic`)) : createEmptyReport();
      const report = await reportJson<SavedReport>(endpoint, reportBody(document));
      router.push(`/projects/${projectId}/reports/${report.id}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The report could not be created."); }
    finally { setBusy(false); }
  };
  const duplicate = async (report: SavedReport) => {
    setBusy(true); setError("");
    try { const copy = await reportJson<SavedReport>(`${endpoint}/${report.id}/duplicate`, { method: "POST" }); setReports((current) => [copy, ...current]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The report could not be duplicated."); }
    finally { setBusy(false); }
  };
  const remove = async (report: SavedReport) => {
    if (!window.confirm(`Delete “${report.name}”, its schedules, and its saved runs?`)) return;
    setBusy(true); setError("");
    try { const response = await fetch(`${endpoint}/${report.id}`, { method: "DELETE" }); if (!response.ok) throw new Error((await response.json()).error || "The report could not be deleted."); setReports((current) => current.filter((entry) => entry.id !== report.id)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The report could not be deleted."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Reports" className={styles.list}>
    <div className={styles.toolbar}><p>Reusable, paginated views of your warehouse.</p><div className={styles.actions}><Button variant="outline" disabled={busy || !editable} onClick={() => { void create(true); }}><Sparkles size={14} aria-hidden="true" />Generate starter report</Button><Button disabled={busy || !editable} onClick={() => { void create(false); }}><Plus size={14} aria-hidden="true" />New report</Button></div></div>
    {error && <div className={styles.error} role="alert">{error}<Button variant="ghost" size="sm" onClick={() => { setError(""); setLoading(true); setAttempt((value) => value + 1); }}>Retry</Button></div>}
    {loading ? <div className={styles.empty} role="status"><Loader2 size={24} aria-hidden="true" /><p>Loading reports…</p></div> : reports.length ? <div className={styles.cards}>{reports.map((report) => <article key={report.id} className={styles.card}><Link href={`/projects/${projectId}/reports/${report.id}`}><FileBarChart2 size={21} aria-hidden="true" /><h2>{report.name}</h2><p>{report.description || "Tables, summaries, and charts, ready to print or export."}</p><div className={styles.meta}><span>{report.definition.parameters.length} parameters</span><span>{report.scheduleCount ? `${report.scheduleCount} scheduled` : "On demand"}</span></div><small>{report.lastRun ? `Last run ${new Date(report.lastRun.startedAt).toLocaleString()} · ${report.lastRun.status}` : "No runs yet"}</small></Link><div className={styles.actions}><Button size="sm" variant="ghost" disabled={busy || !editable} aria-label={`Duplicate ${report.name}`} onClick={() => { void duplicate(report); }}><Copy size={13} aria-hidden="true" />Duplicate</Button><Button size="icon" variant="ghost" disabled={busy || !editable} aria-label={`Delete ${report.name}`} onClick={() => { void remove(report); }}><Trash2 size={13} aria-hidden="true" /></Button></div></article>)}</div> : <div className={styles.empty}><FileBarChart2 size={32} aria-hidden="true" /><h2>Your next report starts here</h2><p>Choose fields, add parameters, and produce a PDF, workbook, or CSV from the same report.</p><Button variant="outline" disabled={busy || !editable} onClick={() => { void create(true); }}><Sparkles size={14} aria-hidden="true" />Generate starter report</Button></div>}
  </section>;
}
