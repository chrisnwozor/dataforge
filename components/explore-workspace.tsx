"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { ArrowUp, BarChart3, Check, ChevronRight, Clock3, Code2, GripVertical, Loader2, MoveHorizontal, PanelRightClose, PanelRightOpen, RefreshCw, Save, Share2, Sigma, SlidersHorizontal, Table2, X } from "lucide-react";
import type { SemanticModel } from "@/lib/semantic/types";
import type { AttributeRef, QueryTimings, QueryValue } from "@/lib/semantic/query/types";
import { attributeKey, createStarterView, viewReducer, type ExploreShelf, type ViewConfig, type Visualization } from "@/lib/explore/config";
import { decodeViewConfig, encodeViewConfig } from "@/lib/explore/url";
import { drillDown, drillThrough, drillUp, type DrillStep } from "@/lib/explore/drill";
import { formatValue } from "@/lib/explore/format";
import { exportChart } from "@/components/charts";
import { Button } from "./ui/button";
import { SelectMenu } from "./select-menu";
import { ExploreFields, type ExploreField } from "./explore/fields";
import { ExploreFilters, TopNControl, prefetchExploreValues } from "./explore/filters";
import { ExploreResults } from "./explore/results";
import { buildExploreRequests, useExploreQuery } from "./explore/use-explore-query";
import styles from "./explore-workspace.module.css";

interface SavedView { id: string; projectId: string; name: string; config: ViewConfig; createdAt: string; updatedAt: string }
interface Member { attribute: AttributeRef; value: QueryValue }
const visualizationOptions = [{ value: "table", label: "Table" }, { value: "pivot", label: "Pivot" }, { value: "bar", label: "Bar" }, { value: "line", label: "Line" }, { value: "area", label: "Area" }, { value: "donut", label: "Donut" }, { value: "kpi", label: "KPI cards" }] as const;

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "The request could not be completed. Try again.");
  return body as T;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed. Try again.";

export function ExploreWorkspace({ projectId, initialModel = null, initialError = "" }: { projectId: string; initialModel?: SemanticModel | null; initialError?: string }) {
  const [model, setModel] = useState(initialModel);
  const [loading, setLoading] = useState(!initialModel);
  const [error, setError] = useState(initialError);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (initialModel) return;
    const controller = new AbortController();
    jsonRequest<SemanticModel>(`/api/projects/${encodeURIComponent(projectId)}/semantic`, { signal: controller.signal }).then(setModel).catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, initialModel, attempt]);
  if (model) return <ExploreCanvas key={`${projectId}:${model.version}`} projectId={projectId} model={model} />;
  return <div className={styles.blocked} role={loading ? "status" : undefined}>{loading ? <><Loader2 size={22} className={styles.spin} aria-hidden="true" /><h2>Preparing your fields…</h2></> : <><BarChart3 size={26} aria-hidden="true" /><h2>Your warehouse is the starting point</h2><p>{error || "Configure a SQL Server connection and complete a successful load to explore your data."}</p><div className={styles.toolbarActions}><Link href="/settings" className="button button-outline">Connection settings</Link><Link href={`/projects/${projectId}/generate`} className="button button-outline">Go to Generate</Link><Button variant="ghost" onClick={() => { setLoading(true); setAttempt((value) => value + 1); }}>Try again</Button></div></>}</div>;
}

function Shelf({ shelf, label, children, empty }: { shelf: ExploreShelf | "filters"; label: string; children?: ReactNode; empty: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `shelf:${shelf}`, data: { shelf } });
  return <div ref={setNodeRef} className={`${styles.shelf} ${isOver ? styles.shelfOver : ""}`} role="region" aria-label={`${label} shelf`}><span className={styles.shelfLabel}>{label === "Values" ? <Sigma size={13} aria-hidden="true" /> : <GripVertical size={12} aria-hidden="true" />}{label}</span><div className={styles.shelfFields}>{children}{empty && <span className={styles.dropHint}>Drop {label === "Values" ? "measures" : "attributes"} here</span>}</div></div>;
}

function NameDialog({ mode, initialName, busy, error, onSubmit, onClose }: { mode: "saveAs" | "rename"; initialName: string; busy: boolean; error: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(initialName);
  const id = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={id} onCancel={onClose} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); onSubmit(name.trim()); }}><h2 id={id}>{mode === "rename" ? "Rename view" : "Save a view"}</h2><p>Keep your fields, filters, chart, and formatting together.</p><label className={styles.control}>View name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} autoFocus placeholder="e.g. Sales by category" /></label>{error && <p className={styles.error} role="alert">{error}</p>}<div className={styles.dialogActions}><Button variant="outline" type="button" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Saving…" : mode === "rename" ? "Rename" : "Save view"}</Button></div></form></dialog>;
}

function TimingPanel({ timings }: { timings?: QueryTimings }) {
  const labels: [keyof QueryTimings, string][] = [["parseMs", "Parse"], ["compileMs", "Node compile"], ["cacheLookupMs", "Cache lookup"], ["poolAcquireMs", "Pool acquire"], ["connectMs", "Connect"], ["sendToFirstRowMs", "Send → first row"], ["fetchMs", "Fetch"], ["sqlCompileMs", "SQL compile"], ["sqlExecuteMs", "SQL execute"], ["totalMs", "Total"]];
  return <section aria-label="Explore timing breakdown" className={styles.timing}><h3>Timing</h3>{!timings ? <p className={styles.small}>Run a query to see its timing breakdown.</p> : <dl>{labels.map(([key, label]) => <div key={key} className={typeof timings[key] === "number" && timings[key]! > 2000 ? styles.slowPhase : undefined}><dt>{label}{typeof timings[key] === "number" && timings[key]! > 2000 && <span> over 2 s</span>}</dt><dd>{typeof timings[key] === "number" ? `${timings[key]!.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms` : "Unavailable"}</dd></div>)}</dl>}</section>;
}

function ExploreCanvas({ projectId, model }: { projectId: string; model: SemanticModel }) {
  const [config, dispatch] = useReducer(viewReducer, model, createStarterView);
  const [initialized, setInitialized] = useState(false);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [selectedView, setSelectedView] = useState<SavedView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [nameDialog, setNameDialog] = useState<"saveAs" | "rename" | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<"format" | "sql">("format");
  const [dragging, setDragging] = useState<ExploreField | null>(null);
  const [member, setMember] = useState<Member | null>(null);
  const [drills, setDrills] = useState<DrillStep[]>([]);
  const [requestedAttribute, setRequestedAttribute] = useState<AttributeRef | null>(null);
  const chartRoot = useRef<HTMLDivElement>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/explore/views`;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }));
  const query = useExploreQuery(projectId, initialized ? config : null);
  const dirty = selectedView !== null && JSON.stringify(selectedView.config) !== JSON.stringify(config);
  const attributes = useMemo(() => model.tables.flatMap((table) => table.columns.filter((column) => column.role === "attribute").map((column) => ({ ref: { table: table.id, column: column.id }, label: `${table.name} · ${column.name}` }))), [model]);
  const fieldLabel = useCallback((field: AttributeRef | string) => {
    if (typeof field === "string") return model.measures.find((measure) => measure.id === field)?.name ?? field;
    const table = model.tables.find((item) => item.id === field.table || item.name === field.table);
    return table?.columns.find((column) => column.id === field.column || column.name === field.column)?.name ?? field.column;
  }, [model]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URL(window.location.href).searchParams;
    const viewId = params.get("view");
    const encoded = params.get("config");
    jsonRequest<{ views: SavedView[] }>(endpoint, { signal: controller.signal }).then((value) => setSavedViews(value.views)).catch((error) => { if (!controller.signal.aborted) setActionError(errorMessage(error)); });
    const initialize = async () => {
      try {
        if (viewId) {
          const view = await jsonRequest<SavedView>(`${endpoint}/${encodeURIComponent(viewId)}`, { signal: controller.signal });
          if (!controller.signal.aborted) { setSelectedView(view); dispatch({ type: "replace", config: view.config }); }
        } else if (encoded) {
          const decoded = decodeViewConfig(encoded);
          if (!decoded) throw new Error("This shared view is invalid or uses an unsupported version. A starter view is shown instead.");
          dispatch({ type: "replace", config: decoded });
        }
      } catch (error) { if (!controller.signal.aborted) setActionError(errorMessage(error)); }
      finally { if (!controller.signal.aborted) setInitialized(true); }
    };
    void initialize();
    return () => controller.abort();
  }, [endpoint]);

  useEffect(() => {
    if (!initialized) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("view"); url.searchParams.delete("config");
    try {
      if (selectedView && !dirty) url.searchParams.set("view", selectedView.id);
      else url.searchParams.set("config", encodeViewConfig(config));
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // Very large slicer lists remain usable and saveable even when they exceed the share-link budget.
      window.history.replaceState(window.history.state, "", url);
      queueMicrotask(() => setActionError("This view is too large for a share link. Save the view and share its saved-view URL instead."));
    }
  }, [config, initialized, selectedView, dirty]);

  useEffect(() => { prefetchExploreValues(projectId, [...config.filters.map((filter) => filter.attribute), ...config.rows, ...attributes.slice(0, 2).map((item) => item.ref)].slice(0, 2), model.version); }, [projectId, attributes, config.rows, config.filters, model.version]);

  const addField = useCallback((item: ExploreField, target?: string) => {
    if (target === "filters" && item.kind === "attribute") { setRequestedAttribute(item.field); return; }
    const shelf = item.kind === "measure" ? "values" : target === "columns" ? "columns" : "rows";
    dispatch({ type: "add", shelf, field: item.field });
    setMember(null);
  }, []);
  const startDrag = (event: DragStartEvent) => setDragging(event.active.data.current as ExploreField);
  const endDrag = (event: DragEndEvent) => {
    const field = event.active.data.current as ExploreField | undefined;
    const shelf = event.over?.data.current?.shelf;
    if (field && typeof shelf === "string" && ((field.kind === "measure" && shelf === "values") || (field.kind === "attribute" && shelf !== "values"))) addField(field, shelf);
    setDragging(null);
  };

  const openView = async (viewId: string) => {
    if (!viewId) return;
    setBusy(true); setActionError("");
    try {
      const view = await jsonRequest<SavedView>(`${endpoint}/${encodeURIComponent(viewId)}`);
      setSelectedView(view); dispatch({ type: "replace", config: view.config }); setDrills([]); setMember(null); setNotice(`Opened “${view.name}”.`);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const saveView = async (name?: string) => {
    setBusy(true); setActionError(""); setDialogError("");
    const rename = nameDialog === "rename";
    const creating = !selectedView || nameDialog === "saveAs";
    try {
      const saved = await jsonRequest<SavedView>(creating ? endpoint : `${endpoint}/${encodeURIComponent(selectedView!.id)}`, { method: creating ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rename ? { name } : { name: name ?? selectedView?.name ?? "Untitled view", config }) });
      setSavedViews((previous) => [...previous.filter((view) => view.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name)));
      setSelectedView(saved); setNameDialog(null); setNotice(`Saved “${saved.name}”.`);
    } catch (error) { if (nameDialog) setDialogError(errorMessage(error)); else setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const deleteView = async () => {
    if (!selectedView || !window.confirm(`Delete the saved view “${selectedView.name}”? Your current canvas will remain open.`)) return;
    setBusy(true); setActionError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(selectedView.id)}`, { method: "DELETE" });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error ?? "The view could not be deleted."); }
      setSavedViews((previous) => previous.filter((view) => view.id !== selectedView.id)); setSelectedView(null); setNotice("Saved view deleted. Your canvas is still open.");
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const share = async () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("view"); url.searchParams.delete("config");
    try {
      if (selectedView && !dirty) url.searchParams.set("view", selectedView.id);
      else url.searchParams.set("config", encodeViewConfig(config));
    } catch { setActionError("This view is too large for a share link. Save it first, then share its saved-view URL."); return; }
    try {
      await navigator.clipboard.writeText(url.toString()); setNotice("Share link copied. It includes the view configuration, without query results.");
    } catch { window.history.replaceState(window.history.state, "", url); setNotice("Copy the address bar to share this view."); }
  };
  const downloadCsv = async () => {
    setBusy(true); setActionError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/query`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/csv" }, body: JSON.stringify(buildExploreRequests(config).query) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error ?? "The CSV could not be exported."); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "dataforge-explore.csv"; anchor.click(); URL.revokeObjectURL(url);
      setNotice(response.headers.get("X-DataForge-Truncated") === "true" ? "CSV exported with a truncated result. The query reached its 50,000-row or 50-column pivot limit." : "CSV exported from the server.");
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  };
  const downloadChart = async (format: "svg" | "png") => {
    if (!chartRoot.current) return;
    try { await exportChart(chartRoot.current, format, "dataforge-explore"); setNotice(`Chart exported as ${format.toUpperCase()}.`); } catch (error) { setActionError(errorMessage(error)); }
  };
  const sortRef = config.sort[0]?.ref;
  const sortValue = !sortRef ? "none" : typeof sortRef === "string" ? `m:${sortRef}` : `a:${attributeKey(sortRef)}`;
  const sortOptions = [{ value: "none", label: "Default order" }, ...config.values.map((id) => ({ value: `m:${id}`, label: fieldLabel(id) })), ...[...config.rows, ...config.columns].map((ref) => ({ value: `a:${attributeKey(ref)}`, label: fieldLabel(ref) }))];
  const diagnostics = query.error ?? query.result;
  const canDrill = member ? drillDown(config, model, member.attribute, member.value) : null;

  return <DndContext sensors={sensors} onDragStart={startDrag} onDragEnd={endDrag} onDragCancel={() => setDragging(null)} accessibility={{ screenReaderInstructions: { draggable: "Press Space to pick up a field. Use arrow keys to move it to a shelf and press Space to drop. Press Escape to cancel. Press Enter to add a field directly." } }}>
    <section className={styles.workspace} aria-label="Explore workspace">
      <div className={styles.toolbar}>
        <div className={styles.viewName}><BarChart3 size={16} aria-hidden="true" /><strong>{selectedView?.name ?? "Untitled view"}</strong>{dirty && <span className={styles.small}>Edited</span>}</div>
        <div className={styles.toolbarActions}>
          <SelectMenu label="Open view" value={selectedView?.id ?? ""} options={[{ value: "", label: "Open view…" }, ...savedViews.map((view) => ({ value: view.id, label: view.name }))]} onValueChange={(value) => { void openView(value); }} />
          <Button size="sm" variant="outline" onClick={() => { if (selectedView) void saveView(); else { setDialogError(""); setNameDialog("saveAs"); } }} disabled={busy}><Save size={13} aria-hidden="true" />Save</Button>
          <SelectMenu label="View actions" value="actions" options={[{ value: "actions", label: "More…" }, { value: "saveAs", label: "Save as…" }, ...(selectedView ? [{ value: "rename", label: "Rename…" }, { value: "delete", label: "Delete view" }] : [])]} onValueChange={(value) => { if (value === "delete") void deleteView(); else if (value === "saveAs" || value === "rename") { setDialogError(""); setNameDialog(value); } }} />
          <Button size="sm" variant="ghost" onClick={() => { void share(); }}><Share2 size={13} aria-hidden="true" />Share</Button>
          <SelectMenu label="Export" value="export" options={[{ value: "export", label: "Export…" }, { value: "csv", label: "Result as CSV" }, ...(config.viz !== "table" && config.viz !== "pivot" ? [{ value: "svg", label: "Chart as SVG" }, { value: "png", label: "Chart as PNG" }] : [])]} onValueChange={(value) => { if (value === "csv") void downloadCsv(); else if (value === "svg" || value === "png") void downloadChart(value); }} />
          <Button size="icon" variant="ghost" aria-label={rightOpen ? "Collapse formatting panel" : "Open formatting panel"} onClick={() => setRightOpen((open) => !open)}>{rightOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</Button>
        </div>
      </div>
      {notice && <div className={styles.notice} role="status"><Check size={13} aria-hidden="true" /><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}><X size={12} /></button></div>}
      {actionError && <div className={styles.error} role="alert">{actionError}<button type="button" aria-label="Dismiss error" onClick={() => setActionError("")}><X size={12} /></button></div>}
      <div className={`${styles.layout} ${rightOpen ? "" : styles.panelCollapsed}`}>
        <ExploreFields model={model} onAdd={addField} />
        <div className={styles.canvas}>
          <div className={styles.canvasToolbar}><span className={styles.small}><Table2 size={13} aria-hidden="true" />Visualization</span><SelectMenu label="Visualization" value={config.viz} options={visualizationOptions} onValueChange={(viz) => dispatch({ type: "viz", viz: viz as Visualization })} /><Button size="sm" variant="ghost" aria-label="Refresh results" onClick={query.retry} disabled={query.loading || !config.values.length}><RefreshCw size={13} aria-hidden="true" /></Button><div className={styles.queryStatus} aria-live="polite">{query.result && <><Clock3 size={12} aria-hidden="true" /><span>{query.result.elapsedMs.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms</span><span className={styles.cacheBadge}>{query.result.fromCache ? "cached" : "live"}</span></>}</div></div>
          <div className={styles.shelves}>
            {(["rows", "columns", "values"] as const).map((shelf) => <Shelf key={shelf} shelf={shelf} label={shelf[0].toUpperCase() + shelf.slice(1)} empty={!config[shelf].length}>{config[shelf].map((field, index) => <span className={`${styles.chip} ${shelf === "values" ? styles.measureChip : ""}`} key={typeof field === "string" ? field : attributeKey(field)}>{fieldLabel(field)}{shelf !== "values" && <button type="button" aria-label={`Move ${fieldLabel(field)} to ${shelf === "rows" ? "Columns" : "Rows"}`} title={`Move to ${shelf === "rows" ? "Columns" : "Rows"}`} onClick={() => dispatch({ type: "move", from: shelf, to: shelf === "rows" ? "columns" : "rows", index })}><MoveHorizontal size={11} aria-hidden="true" /></button>}<button type="button" aria-label={`Remove ${fieldLabel(field)} from ${shelf}`} onClick={() => dispatch({ type: "remove", shelf, index })}><X size={12} aria-hidden="true" /></button></span>)}</Shelf>)}
            <Shelf shelf="filters" label="Filters" empty={false}><ExploreFilters projectId={projectId} model={model} filters={config.filters} onChange={(filters) => dispatch({ type: "filters", filters })} topN={config.topN} onTopNChange={(topN) => { if (topN && !config.values.includes(topN.measure)) dispatch({ type: "add", shelf: "values", field: topN.measure }); dispatch({ type: "topN", topN }); }} requestedAttribute={requestedAttribute} onRequestedAttributeHandled={() => setRequestedAttribute(null)} /></Shelf>
          </div>
          <div className={styles.resultHeading}><h2>{config.options.title || (config.values.length ? `${config.values.map(fieldLabel).join(", ")}${config.rows.length ? ` by ${config.rows.map(fieldLabel).join(" / ")}` : ""}` : "Choose a measure to get started")}</h2></div>
          {drills.length > 0 && <nav className={styles.breadcrumbs} aria-label="Drill path"><Button size="sm" variant="ghost" onClick={() => { const step = drills[drills.length - 1]; dispatch({ type: "replace", config: drillUp(config, step) }); setDrills((previous) => previous.slice(0, -1)); setMember(null); }}><ArrowUp size={12} aria-hidden="true" />Drill up</Button>{drills.map((step, index) => <span key={`${attributeKey(step.attribute)}:${index}`}>{fieldLabel(step.attribute)}: {formatValue(step.value)}<ChevronRight size={12} aria-hidden="true" /></span>)}</nav>}
          {member && <div className={styles.memberMenu} role="region" aria-label="Member actions"><span>{fieldLabel(member.attribute)}: <strong>{formatValue(member.value)}</strong></span><Button size="sm" variant="outline" disabled={!canDrill} onClick={() => { if (!canDrill) return; dispatch({ type: "replace", config: canDrill.config }); setDrills((previous) => [...previous, canDrill.step]); setMember(null); }}>Drill down</Button><Button size="sm" variant="outline" onClick={() => { dispatch({ type: "replace", config: drillThrough(config, member.attribute, member.value) }); setMember(null); }}>Drill through</Button><Button size="icon" variant="ghost" aria-label="Close member actions" onClick={() => setMember(null)}><X size={13} /></Button></div>}
          {query.loading && query.slow && <div className={styles.queryProgress} role="status"><Loader2 size={14} className={styles.spin} aria-hidden="true" /><span>Query running · {(query.elapsedMs / 1000).toFixed(1)} s</span><Button size="sm" variant="outline" onClick={query.cancel}>Cancel query</Button></div>}
          {query.error && <div className={styles.queryError} role="alert"><strong>We couldn’t complete this query</strong><p>{query.error.message}</p><div className={styles.toolbarActions}><Button size="sm" variant="outline" onClick={query.retry}>Try again</Button><Button size="sm" variant="ghost" onClick={() => { setRightOpen(true); setRightTab("sql"); }}>View SQL and timing</Button></div></div>}
          {query.totalsError && <p className={styles.error} role="alert">{query.totalsError}</p>}
          <div ref={chartRoot} className={styles.resultRoot} aria-busy={query.loading}>
            {query.result ? <ExploreResults config={config} resultConfig={query.resultConfig} model={model} result={query.result} totals={query.totals} loading={query.loading} onMemberClick={(attribute, value) => setMember({ attribute, value })} /> : query.loading ? <div className={styles.skeleton} role="status" aria-label="Loading query results">{Array.from({ length: 7 }, (_, index) => <div key={index} />)}</div> : !query.error && <div className={styles.empty}><BarChart3 size={26} aria-hidden="true" /><h3>Your next question starts here</h3><p>Add a measure to Values, and an attribute to Rows or Columns.</p></div>}
          </div>
        </div>
        {rightOpen && <aside className={styles.rightPanel} aria-label="Explore options"><div className={styles.panelTabs} role="tablist" aria-label="Explore panel" onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const next = event.key === "Home" ? "format" : event.key === "End" ? "sql" : rightTab === "format" ? "sql" : "format"; setRightTab(next); event.currentTarget.querySelector<HTMLButtonElement>(`#explore-${next}-tab`)?.focus(); }}><button type="button" role="tab" tabIndex={rightTab === "format" ? 0 : -1} id="explore-format-tab" aria-controls="explore-format-panel" aria-selected={rightTab === "format"} onClick={() => setRightTab("format")}><SlidersHorizontal size={13} aria-hidden="true" />Format</button><button type="button" role="tab" tabIndex={rightTab === "sql" ? 0 : -1} id="explore-sql-tab" aria-controls="explore-sql-panel" aria-selected={rightTab === "sql"} onClick={() => setRightTab("sql")}><Code2 size={13} aria-hidden="true" />SQL</button></div>
          {rightTab === "format" ? <div id="explore-format-panel" role="tabpanel" aria-labelledby="explore-format-tab" className={styles.panelBody}>
            <label className={styles.control}>Title<input value={config.options.title} maxLength={200} placeholder="Automatic title" onChange={(event) => dispatch({ type: "options", options: { title: event.target.value } })} /></label>
            <div className={styles.control}><span>Number format</span><SelectMenu label="Number format" value={config.options.numberFormat} options={[{ value: "auto", label: "From each measure" }, { value: "number", label: "Number" }, { value: "currency", label: "Currency" }, { value: "percent", label: "Percent" }, { value: "decimals", label: "2 decimal places" }]} onValueChange={(numberFormat) => dispatch({ type: "options", options: { numberFormat: numberFormat as ViewConfig["options"]["numberFormat"] } })} /></div>
            <div className={styles.control}><span>Sort by</span><SelectMenu label="Sort field" value={sortValue} options={sortOptions} onValueChange={(value) => { if (value === "none") dispatch({ type: "sort", sort: [] }); else { const ref = value.startsWith("m:") ? value.slice(2) : [...config.rows, ...config.columns].find((item) => `a:${attributeKey(item)}` === value); if (ref) dispatch({ type: "sort", sort: [{ ref, dir: config.sort[0]?.dir ?? "desc" }] }); } }} /></div>
            {sortRef && <div className={styles.control}><span>Order</span><SelectMenu label="Sort order" value={config.sort[0]?.dir ?? "desc"} options={[{ value: "desc", label: "Descending" }, { value: "asc", label: "Ascending" }]} onValueChange={(dir) => dispatch({ type: "sort", sort: [{ ref: sortRef, dir: dir as "asc" | "desc" }] })} /></div>}
            <div className={styles.control}><span>Top N by measure</span><TopNControl key={`${config.topN?.measure}:${config.topN?.n}`} model={model} topN={config.topN} onChange={(topN) => { if (topN && !config.values.includes(topN.measure)) dispatch({ type: "add", shelf: "values", field: topN.measure }); dispatch({ type: "topN", topN }); }} /></div>
            {config.viz === "pivot" && <><label className={styles.checkControl}><input type="checkbox" checked={config.options.showTotals} onChange={(event) => dispatch({ type: "options", options: { showTotals: event.target.checked } })} />Show server-calculated totals</label><p className={styles.small}>Totals are queried at their own grain, including ratios and averages.</p></>}
            {config.viz !== "table" && config.viz !== "pivot" && <label className={styles.checkControl}><input type="checkbox" checked={config.options.showLegend} onChange={(event) => dispatch({ type: "options", options: { showLegend: event.target.checked } })} />Show legend</label>}
            {config.viz === "bar" && <><div className={styles.control}><span>Orientation</span><SelectMenu label="Bar orientation" value={config.options.barOrientation} options={[{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal" }]} onValueChange={(barOrientation) => dispatch({ type: "options", options: { barOrientation: barOrientation as "horizontal" | "vertical" } })} /></div><label className={styles.checkControl}><input type="checkbox" checked={config.options.stacked} onChange={(event) => dispatch({ type: "options", options: { stacked: event.target.checked } })} />Stack series</label></>}
            {config.viz !== "table" && config.viz !== "pivot" && <><h3>Series colors</h3>{config.values.map((measure, index) => <label key={measure} className={styles.colorControl}><span>{fieldLabel(measure)}</span><input type="color" aria-label={`Color for ${fieldLabel(measure)}`} value={config.options.seriesColors[index] ?? ["#79aaff", "#63c58f", "#d9ad58", "#c49bf4", "#f78181"][index % 5]} onChange={(event) => { const colors = [...config.options.seriesColors]; while (colors.length <= index) colors.push(["#79aaff", "#63c58f", "#d9ad58", "#c49bf4", "#f78181"][colors.length % 5]); colors[index] = event.target.value; dispatch({ type: "options", options: { seriesColors: colors } }); }} /></label>)}</>}
          </div> : <div id="explore-sql-panel" role="tabpanel" aria-labelledby="explore-sql-tab" className={styles.panelBody}><div className={styles.sqlHeading}><h3>Generated T-SQL</h3><span className={styles.cacheBadge}>{query.result?.fromCache ? "cached" : "live"}</span></div><p className={styles.small}>Read-only output from the semantic query API.</p><pre className={styles.sql} tabIndex={0} aria-label="Generated SQL">{diagnostics?.sql || "Add a measure and run a query to see its generated SQL."}</pre>{diagnostics?.params?.length ? <details className={styles.parameters}><summary>Typed parameters</summary><pre>{JSON.stringify(diagnostics.params, null, 2)}</pre></details> : null}<TimingPanel timings={diagnostics?.timings} /></div>}
        </aside>}
      </div>
    </section>
    <DragOverlay>{dragging && <span className={`${styles.chip} ${styles.dragOverlay}`}><GripVertical size={12} aria-hidden="true" />{dragging.label}</span>}</DragOverlay>
    {nameDialog && <NameDialog mode={nameDialog} initialName={nameDialog === "rename" ? selectedView?.name ?? "" : selectedView ? `${selectedView.name} copy` : config.options.title || ""} busy={busy} error={dialogError} onSubmit={(name) => { void saveView(name); }} onClose={() => { if (!busy) setNameDialog(null); }} />}
  </DndContext>;
}
