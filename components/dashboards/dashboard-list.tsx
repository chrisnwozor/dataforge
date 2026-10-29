"use client";
import {canEdit,useWorkspaceRole} from "@/components/auth/provider";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Copy, LayoutDashboard, Loader2, MoreHorizontal, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createEmptyDashboard, type SavedDashboard } from "@/lib/dashboards/schema";
import { generateStarterDashboard } from "@/lib/dashboards/starter";
import type { SemanticModel } from "@/lib/semantic/types";
import styles from "./list.module.css";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "The dashboard request could not be completed.");
  return body as T;
}
function DashboardNameDialog({ initial, onSubmit, onClose, busy, error }: { initial?: SavedDashboard; onSubmit: (name: string, description: string) => void; onClose: () => void; busy: boolean; error: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [name, setName] = useState(initial?.name ?? "Untitled dashboard");
  const [description, setDescription] = useState(initial?.description ?? "");
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={id} onCancel={onClose} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit(name.trim(), description); }}><h2 id={id}>{initial ? "Rename dashboard" : "New dashboard"}</h2><label>Name<input aria-label="Dashboard name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoFocus required /></label><label>Description<textarea value={description} maxLength={2000} rows={3} onChange={(event) => setDescription(event.target.value)} /></label>{error && <p className={styles.error} role="alert">{error}</p>}<div className={styles.actions}><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : initial ? "Rename" : "Create dashboard"}</Button></div></form></dialog>;
}
export function DashboardList({ projectId }: { projectId: string }) {
  const router = useRouter();
  const editable=canEdit(useWorkspaceRole());
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/dashboards`;
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"new" | SavedDashboard | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    json<{ dashboards: SavedDashboard[] }>(endpoint, { signal: controller.signal }).then((body) => setDashboards(body.dashboards)).catch((error) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Dashboards could not be loaded."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const save = async (name: string, description: string) => {
    setBusy(true); setDialogError("");
    try {
      const initial = dialog !== "new" ? dialog : null;
      const saved = await json<SavedDashboard>(initial ? `${endpoint}/${initial.id}` : endpoint, { method: initial ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initial ? { name, description, updatedAt: initial.updatedAt } : { ...createEmptyDashboard(name), description }) });
      setDashboards((previous) => [...previous.filter((entry) => entry.id !== saved.id), saved]); setDialog(null);
      if (!initial) router.push(`/projects/${projectId}/dashboards/${saved.id}?edit=1`);
    } catch (error) { setDialogError(error instanceof Error ? error.message : "The dashboard could not be saved."); }
    finally { setBusy(false); }
  };
  const starter = async () => {
    setBusy(true); setError("");
    try {
      const model = await json<SemanticModel>(`/api/projects/${encodeURIComponent(projectId)}/semantic`);
      const saved = await json<SavedDashboard>(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(generateStarterDashboard(model)) });
      router.push(`/projects/${projectId}/dashboards/${saved.id}?edit=1`);
    } catch (error) { setError(error instanceof Error ? error.message : "A starter dashboard could not be generated."); }
    finally { setBusy(false); }
  };
  const duplicate = async (dashboard: SavedDashboard) => {
    setBusy(true); setError("");
    try { const saved = await json<SavedDashboard>(`${endpoint}/${dashboard.id}/duplicate`, { method: "POST" }); setDashboards((previous) => [saved, ...previous]); }
    catch (error) { setError(error instanceof Error ? error.message : "The dashboard could not be duplicated."); }
    finally { setBusy(false); }
  };
  const remove = async (dashboard: SavedDashboard) => {
    if (!window.confirm(`Delete “${dashboard.name}”? This removes its saved dashboard and tiles.`)) return;
    setBusy(true); setError("");
    try { const response = await fetch(`${endpoint}/${dashboard.id}`, { method: "DELETE" }); if (!response.ok) throw new Error((await response.json()).error || "The dashboard could not be deleted."); setDashboards((previous) => previous.filter((entry) => entry.id !== dashboard.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "The dashboard could not be deleted."); }
    finally { setBusy(false); }
  };
  return <section className={styles.root} aria-label="Dashboards"><div className={styles.toolbar}><p>A home for the questions you come back to.</p><div className={styles.actions}><Button variant="outline" disabled={busy || !editable} onClick={() => { void starter(); }}><Sparkles size={14} aria-hidden="true" />Generate starter dashboard</Button><Button disabled={busy || !editable} onClick={() => { setDialogError(""); setDialog("new"); }}><Plus size={14} aria-hidden="true" />New dashboard</Button></div></div>{error && <div role="alert" className={styles.error}>{error}{loading || dashboards.length ? null : <Button size="sm" variant="ghost" onClick={() => { setError(""); setLoading(true); setAttempt((value) => value + 1); }}>Retry</Button>}</div>}{loading ? <div className={styles.empty} role="status"><Loader2 className={styles.spin} size={22} aria-hidden="true" /><p>Loading dashboards…</p></div> : dashboards.length ? <div className={styles.cards}>{dashboards.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((dashboard) => <article key={dashboard.id} className={styles.card}><Link href={`/projects/${projectId}/dashboards/${dashboard.id}`} className={styles.cardMain}><span className={styles.cardIcon}><LayoutDashboard size={18} aria-hidden="true" /></span><h2>{dashboard.name}</h2><p>{dashboard.description || "Your saved views, together in one place."}</p><div className={styles.meta}><span>{dashboard.layout.tiles.length} tiles</span><time dateTime={dashboard.updatedAt}>Updated {new Date(dashboard.updatedAt).toLocaleDateString()}</time></div></Link><div className={styles.cardActions}><Button size="sm" variant="ghost" aria-label={`Rename ${dashboard.name}`} disabled={busy || !editable} onClick={() => { setDialogError(""); setDialog(dashboard); }}><MoreHorizontal size={13} aria-hidden="true" />Rename</Button><Button size="sm" variant="ghost" aria-label={`Duplicate ${dashboard.name}`} disabled={busy || !editable} onClick={() => { void duplicate(dashboard); }}><Copy size={13} aria-hidden="true" />Duplicate</Button><Button size="icon" variant="ghost" aria-label={`Delete ${dashboard.name}`} disabled={busy || !editable} onClick={() => { void remove(dashboard); }}><Trash2 size={13} aria-hidden="true" /></Button></div></article>)}</div> : <div className={styles.empty}><LayoutDashboard size={30} aria-hidden="true" /><h2>A clear view of your data starts here</h2><p>Build a dashboard from saved Explore views, or generate a starter with measures, charts, and slicers.</p><Button variant="outline" disabled={busy || !editable} onClick={() => { void starter(); }}><Sparkles size={14} aria-hidden="true" />Generate starter dashboard</Button></div>}{dialog && <DashboardNameDialog initial={dialog === "new" ? undefined : dialog} busy={busy} error={dialogError} onClose={() => { if (!busy) setDialog(null); }} onSubmit={(name, description) => { void save(name, description); }} />}</section>;
}
