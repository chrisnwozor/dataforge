"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ArrowLeft, BarChart3, Check, Download, FileText, GripVertical, Loader2, Play, Redo2, Search, Table2, Trash2, Undo2, X, Sigma, Diamond } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/select-menu";
import { createReportHistory, reportHistoryReducer } from "@/lib/reports/history";
import { reportDocumentSchema, type ReportColumn, type ReportDataSource, type ReportDocument, type ReportItem, type ReportParameterValues, type SavedReport } from "@/lib/reports/schema";
import { validateReportParameters } from "@/lib/reports/parameters";
import type { PaginatedReport } from "@/lib/reports/pagination";
import type { AttributeRef } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import type { SavedExploreView } from "@/lib/server/explore-views";
import { reportBody, reportJson } from "./api";
import { ReportProperties, refKey, reportAttributes } from "./report-properties";
import { ReportParameters } from "./report-parameters";
import { ReportPreview } from "./report-preview";
import { ReportRuns } from "./report-runs";
import { ReportSchedules } from "./report-schedules";
import { useReportSave } from "./use-report-save";
import styles from "./reports.module.css";

type Field = { kind: "attribute"; attribute: AttributeRef; label: string } | { kind: "measure"; measure: string; label: string };
type ActiveRun = { id: string; status: string; startedAt: string; finishedAt?: string | null; error?: string | null; rowCount?: number; pageCount?: number; filePaths?: Record<string, string> };
const fieldKey = (field: Field) => field.kind === "attribute" ? `attribute:${refKey(field.attribute)}` : `measure:${field.measure}`;
const toDocument = (saved: SavedReport): ReportDocument => ({ name: saved.name, description: saved.description, definition: saved.definition });
const description = (item: ReportItem) => item.type === "text" ? item.content.slice(0, 160) || "Write text in the properties panel." : item.type === "pageBreak" ? "The next item starts on a new page." : item.data.kind === "view" ? "Saved Explore view" : `${item.data.rows.length} attributes · ${item.data.values.length} measures`;

function DraggableField({ field, onAdd }: { field: Field; onAdd: () => void }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `field:${fieldKey(field)}`, data: { kind: "field", field } });
  return <button type="button" ref={setNodeRef} className={styles.field} {...listeners} {...attributes} onClick={onAdd} style={{ opacity: isDragging ? 0.5 : 1 }} aria-label={`Add ${field.label} to report`}>{field.kind === "measure" ? <Sigma size={12} aria-hidden="true" /> : <Diamond size={11} aria-hidden="true" />}{field.label}</button>;
}
function CanvasItem({ item, selected, index, count, onSelect, onMove, onRemove }: { item: ReportItem; selected: boolean; index: number; count: number; onSelect: () => void; onMove: (offset: number) => void; onRemove: () => void }) {
  const drag = useDraggable({ id: item.id, data: { kind: "item" } });
  const drop = useDroppable({ id: item.id });
  return <article ref={(node) => { drag.setNodeRef(node); drop.setNodeRef(node); }} data-report-item-id={item.id} className={`${styles.canvasItem} ${selected ? styles.selectedItem : ""} ${drop.isOver ? styles.dropTarget : ""}`} style={{ opacity: drag.isDragging ? 0.5 : 1, transform: drag.transform ? `translate3d(${drag.transform.x}px,${drag.transform.y}px,0)` : undefined }}>
    <div className={styles.itemToolbar}><button type="button" className={styles.dragHandle} {...drag.listeners} {...drag.attributes} aria-label={`Move ${item.title || item.type} report item`} aria-describedby="report-move-help" onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={15} aria-hidden="true" /></button><button type="button" className={styles.itemTitle} onClick={onSelect} aria-pressed={selected}>{item.type === "table" || item.type === "matrix" ? <Table2 size={14} aria-hidden="true" /> : item.type === "chart" ? <BarChart3 size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}<strong>{item.title || (item.type === "pageBreak" ? "Page break" : `Untitled ${item.type}`)}</strong></button><span className={styles.itemPosition}>{index + 1}/{count}</span><Button variant="ghost" size="icon" aria-label={`Remove ${item.title || item.type} report item`} onClick={onRemove}><Trash2 size={13} aria-hidden="true" /></Button></div>
    <button type="button" className={styles.itemContent} onClick={onSelect}><p>{description(item)}</p>{item.type === "table" && <div className={styles.tableStructure}>{item.columns.map((column) => <span key={column.id}>{column.label || "Column"}</span>)}</div>}{item.type === "matrix" && <p className={styles.note}>{item.rows.length} row groups × {item.columns.length} column groups</p>}{item.type === "chart" && <div className={styles.chartStructure}><BarChart3 size={45} aria-hidden="true" /><span>{item.viz} chart · {item.height} pt</span></div>}{item.type === "pageBreak" && <div className={styles.pageBreakLine}>PAGE BREAK</div>}</button>
  </article>;
}

export function ReportEditor({ projectId, reportId }: { projectId: string; reportId: string }) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}`;
  const [initial, setInitial] = useState<SavedReport | null>(null);
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [views, setViews] = useState<SavedExploreView[]>([]);
  const [error, setError] = useState("");
  const [metadataError, setMetadataError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      reportJson<SavedReport>(endpoint, { signal: controller.signal }).then(setInitial),
      reportJson<SemanticModel>(`/api/projects/${encodeURIComponent(projectId)}/semantic`, { signal: controller.signal }).then(setModel).catch((reason) => { if (!controller.signal.aborted) setMetadataError(reason instanceof Error ? reason.message : "Field metadata is unavailable."); }),
      reportJson<{ views: SavedExploreView[] }>(`/api/projects/${encodeURIComponent(projectId)}/explore/views`, { signal: controller.signal }).then((body) => setViews(body.views)),
    ]).then((results) => { if (!controller.signal.aborted && results[0].status === "rejected") setError(results[0].reason instanceof Error ? results[0].reason.message : "The report could not be loaded."); });
    return () => controller.abort();
  }, [endpoint, projectId]);
  if (error) return <div className={styles.error} role="alert">{error}<Link href={`/projects/${projectId}/reports`}>Back to Reports</Link></div>;
  if (!initial) return <div className={styles.empty} role="status"><Loader2 size={24} aria-hidden="true" /><p>Loading report…</p></div>;
  return <LoadedReportEditor initial={initial} endpoint={endpoint} projectId={projectId} model={model} views={views} metadataError={metadataError} />;
}

function LoadedReportEditor({ initial, endpoint, projectId, model, views, metadataError }: { initial: SavedReport; endpoint: string; projectId: string; model: SemanticModel | null; views: SavedExploreView[]; metadataError: string }) {
  const [history, dispatch] = useReducer(reportHistoryReducer, toDocument(initial), createReportHistory);
  const document = history.present;
    const [selectedId, setSelectedId] = useState(document.definition.items[0]?.id ?? "");
  const [mode, setMode] = useState<"design" | "preview" | "runs" | "schedules">("design");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [parameters, setParameters] = useState<ReportParameterValues>(() => Object.fromEntries(document.definition.parameters.map((parameter) => [parameter.id, parameter.default ?? null])));
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ActiveRun | null>(null);
  const [preview, setPreview] = useState<PaginatedReport | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const activeRun = useRef<string | null>(null);
  const save = useReportSave(endpoint, initial, document);
  const { isDirty } = save;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const changeDocument = useCallback((next: ReportDocument) => {
    const parsed = reportDocumentSchema.safeParse(next);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Complete the report settings."); return; }
    setError(""); dispatch({ type: "set", document: parsed.data });
  }, []);
  const changeItem = (item: ReportItem) => changeDocument({ ...document, definition: { ...document.definition, items: document.definition.items.map((entry) => entry.id === item.id ? item : entry) } });
  const hasDraft = useCallback(() => Array.from(root.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-report-draft=true]") ?? []).some((input) => input.value !== input.defaultValue), []);
  useEffect(() => {
    const guardedUrl = location.href;
    const guardedState = window.history.state;
    const prevent = (event: BeforeUnloadEvent) => { if (isDirty() || hasDraft()) { event.preventDefault(); event.returnValue = ""; } };
    const leave = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (!isDirty() && !hasDraft())) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.href === location.href) return;
      if (!window.confirm("Leave this report with unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    const back = (event: PopStateEvent) => {
      if ((isDirty() || hasDraft()) && !window.confirm("Leave this report with unsaved changes?")) { event.stopImmediatePropagation(); window.history.pushState(guardedState, "", guardedUrl); }
    };
    const shortcut = (event: KeyboardEvent) => { const target = event.target as HTMLElement; if ((event.metaKey || event.ctrlKey) && !["INPUT", "TEXTAREA"].includes(target.tagName) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) { event.preventDefault(); dispatch({ type: event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo" }); } };
    window.addEventListener("beforeunload", prevent); window.addEventListener("keydown", shortcut); window.addEventListener("popstate", back, true); globalThis.document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", prevent); window.removeEventListener("keydown", shortcut); window.removeEventListener("popstate", back, true); globalThis.document.removeEventListener("click", leave, true); };
  }, [isDirty, hasDraft]);
  useEffect(() => () => { if (activeRun.current) void fetch(`${endpoint}/runs/${activeRun.current}/cancel`, { method: "POST", keepalive: true }); }, [endpoint]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const body = await reportJson<{ run: ActiveRun; preview?: PaginatedReport }>(`${endpoint}/runs/${runId}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRun(body.run);
        if (body.preview) setPreview(body.preview);
        if (body.run.status === "queued" || body.run.status === "running") { activeRun.current = runId; timer = setTimeout(() => { void poll(); }, 650); }
        else { activeRun.current = null; setRefreshToken((value) => value + 1); if (body.run.status === "failed") setError(body.run.error || "The report failed. Check the connection and parameters, then retry."); }
      } catch (reason) { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Run status could not be loaded."); timer = setTimeout(() => { void poll(); }, 2000); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint, runId]);
  useEffect(() => {
    if (!run || !["queued", "running"].includes(run.status)) return;
    const clock = setInterval(() => setElapsed(Math.max(0, Date.now() - Date.parse(run.startedAt))), 100);
    return () => clearInterval(clock);
  }, [run]);
  const startRun = async () => {
    setError(""); setRunStarting(true);
    try {
      const values = Object.fromEntries(document.definition.parameters.map((parameter) => [parameter.id, Object.hasOwn(parameters, parameter.id) ? parameters[parameter.id] : parameter.default ?? null]));
      const validated = validateReportParameters(document.definition, values, model ?? undefined);
      if (!await save.flush()) throw new Error("Save the report before running it.");
      if (activeRun.current) await reportJson(`${endpoint}/runs/${activeRun.current}/cancel`, { method: "POST" });
      const started = await reportJson<ActiveRun>(`${endpoint}/runs`, reportBody({ params: validated, formats: ["pdf", "xlsx", "csv"] }));
      activeRun.current = started.id; setRun(started); setRunId(started.id); setElapsed(0); setMode("preview");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The report could not be started."); }
    finally { setRunStarting(false); }
  };
  const cancelRun = async () => { if (runId) { try { await reportJson(`${endpoint}/runs/${runId}/cancel`, { method: "POST" }); } catch (reason) { setError(reason instanceof Error ? reason.message : "The run could not be cancelled."); } } };
  const attributes = reportAttributes(model);
  const fields: Field[] = [...(model?.measures.map((measure): Field => ({ kind: "measure", measure: measure.id, label: measure.name })) ?? []), ...attributes.map((entry): Field => ({ kind: "attribute", attribute: entry.attribute, label: entry.label }))];
  const firstMeasure = model?.measures[0];
  const defaultSource = (): Extract<ReportDataSource, { kind: "fields" }> => ({ kind: "fields", rows: attributes[0] ? [attributes[0].attribute] : [], values: firstMeasure ? [firstMeasure.id] : [], filters: [], sort: [] });
  const defaultColumns = (source: Extract<ReportDataSource, { kind: "fields" }>): ReportColumn[] => [...source.rows.map((attribute) => ({ id: crypto.randomUUID(), label: attributes.find((entry) => refKey(entry.attribute) === refKey(attribute))?.column.name ?? attribute.column, binding: { kind: "attribute" as const, attribute }, width: 150, format: "auto" as const, align: "left" as const })), ...source.values.map((measure) => ({ id: crypto.randomUUID(), label: model?.measures.find((entry) => entry.id === measure)?.name ?? measure, binding: { kind: "measure" as const, measure }, width: 120, format: "auto" as const, align: "right" as const }))];
  const makeItem = (type: ReportItem["type"], source = defaultSource()): ReportItem | null => {
    const id = crypto.randomUUID();
    if (type === "text") return { id, type, title: "Text block", content: "Add your text here." };
    if (type === "pageBreak") return { id, type, title: "" };
    if (!source.values.length) { setError("Load your warehouse and add a semantic measure before adding a data item. Text and page breaks remain available."); return null; }
    if (type === "chart") return { id, type, title: "Chart", data: source, viz: "bar", height: 220 };
    const grouped = { subtotals: true, grandTotal: true, keepTogether: true, hideOnEmpty: false, conditionalFormats: [] };
    if (type === "matrix") { if (!attributes.length) { setError("A matrix needs a dimension attribute for its row and column groups."); return null; } return { id, type, title: "Matrix", data: source, rows: [attributes[0].attribute], columns: [attributes[1]?.attribute ?? attributes[0].attribute], values: source.values, ...grouped }; }
    return { id, type: "table", title: "Table", data: source, columns: defaultColumns(source), groups: [], ...grouped };
  };
  const addItem = (type: ReportItem["type"]) => { const item = makeItem(type); if (item) { changeDocument({ ...document, definition: { ...document.definition, items: [...document.definition.items, item] } }); setSelectedId(item.id); } };
  const sourceFields = (source: ReportDataSource): Extract<ReportDataSource, { kind: "fields" }> => { if (source.kind === "fields") return { ...source, rows: [...source.rows], values: [...source.values], filters: [...source.filters], sort: [...source.sort] }; const view = views.find((entry) => entry.id === source.viewId)?.config; return view ? { kind: "fields", rows: [...view.rows, ...view.columns], values: view.values, filters: view.filters, sort: view.sort, ...(view.topN ? { topN: view.topN } : {}) } : defaultSource(); };
  const addField = (field: Field, targetId = selectedId) => {
    const existing = document.definition.items.find((item) => item.id === targetId);
    const target = existing && "data" in existing ? existing : makeItem("table", { ...defaultSource(), rows: field.kind === "attribute" ? [field.attribute] : [], values: field.kind === "measure" ? [field.measure] : firstMeasure ? [firstMeasure.id] : [] });
    if (!target || !("data" in target)) return;
    const data = sourceFields(target.data);
    if (field.kind === "attribute" && !data.rows.some((ref) => refKey(ref) === refKey(field.attribute))) data.rows = [...data.rows, field.attribute].slice(0, 12);
    if (field.kind === "measure" && !data.values.includes(field.measure)) data.values = [...data.values, field.measure].slice(0, 64);
    let item: ReportItem = { ...target, data };
    if (item.type === "table") {
      const exists = item.columns.some((column) => field.kind === "attribute" ? column.binding.kind === "attribute" && refKey(column.binding.attribute) === refKey(field.attribute) : column.binding.kind === "measure" && column.binding.measure === field.measure);
      if (!exists) item = { ...item, columns: [...item.columns, { id: crypto.randomUUID(), label: field.kind === "attribute" ? attributes.find((entry) => refKey(entry.attribute) === refKey(field.attribute))?.column.name ?? field.label : field.label, width: 120, align: field.kind === "measure" ? "right" : "left", format: "auto", binding: field.kind === "measure" ? { kind: "measure", measure: field.measure } : { kind: "attribute", attribute: field.attribute } }] };
    } else if (item.type === "matrix") item = { ...item, values: data.values, ...(field.kind === "attribute" && !item.rows.some((ref) => refKey(ref) === refKey(field.attribute)) && item.rows.length < 3 ? { rows: [...item.rows, field.attribute] } : {}) };
    const items = existing && "data" in existing ? document.definition.items.map((entry) => entry.id === item.id ? item : entry) : [...document.definition.items, item];
    changeDocument({ ...document, definition: { ...document.definition, items } }); setSelectedId(item.id);
  };
  const move = (id: string, offset: number) => { const items = [...document.definition.items]; const from = items.findIndex((item) => item.id === id); const to = Math.min(items.length - 1, Math.max(0, from + offset)); if (from < 0 || from === to) return; const [item] = items.splice(from, 1); items.splice(to, 0, item); changeDocument({ ...document, definition: { ...document.definition, items } }); };
  const dragEnd = (event: DragEndEvent) => { if (event.active.data.current?.kind === "field") { addField(event.active.data.current.field as Field, event.over ? String(event.over.id) : selectedId); return; } if (event.over && event.active.id !== event.over.id) { const from = document.definition.items.findIndex((item) => item.id === event.active.id); const to = document.definition.items.findIndex((item) => item.id === event.over!.id); if (from >= 0 && to >= 0) move(String(event.active.id), to - from); } };
  const addSavedView = (view: SavedExploreView) => { const source = sourceFields({ kind: "view", viewId: view.id }); const item = makeItem("table", source); if (item && "data" in item) { const next = { ...item, title: view.name, data: { kind: "view" as const, viewId: view.id } }; changeDocument({ ...document, definition: { ...document.definition, items: [...document.definition.items, next] } }); setSelectedId(item.id); } };
  const selected = document.definition.items.find((item) => item.id === selectedId);
  const running = !!run && ["queued", "running"].includes(run.status);
  return <div ref={root} className={styles.editor}>
    <div className={styles.editorHeader}><div><Link className={styles.back} href={`/projects/${projectId}/reports`}><ArrowLeft size={12} aria-hidden="true" />Reports</Link><h1>{document.name}</h1><p>{document.description || "Design a report once. Preview, export, and schedule it."}</p></div><div className={styles.actions}><span className={styles.saveStatus} role="status">{save.status === "saved" ? <><Check size={12} aria-hidden="true" />Saved</> : save.status === "saving" ? <><Loader2 size={12} aria-hidden="true" />Saving…</> : "Save failed"}</span>{save.status === "error" && <Button size="sm" variant="outline" onClick={() => { void save.flush(); }}>Retry save</Button>}<Button variant="outline" size="sm" disabled={!history.past.length} aria-label="Undo report edit" onClick={() => dispatch({ type: "undo" })}><Undo2 size={14} aria-hidden="true" /></Button><Button variant="outline" size="sm" disabled={!history.future.length} aria-label="Redo report edit" onClick={() => dispatch({ type: "redo" })}><Redo2 size={14} aria-hidden="true" /></Button><Button disabled={runStarting || running} onClick={() => { void startRun(); }}><Play size={13} aria-hidden="true" />{runStarting ? "Starting…" : "Run report"}</Button></div></div>
    {(error || save.error) && <div className={styles.error} role="alert">{error || save.error}<Button size="icon" variant="ghost" aria-label="Dismiss report error" onClick={() => setError("")}><X size={13} aria-hidden="true" /></Button></div>}
    <div className={styles.modeTabs} role="group" aria-label="Report workspace">{(["design", "preview", "runs", "schedules"] as const).map((entry) => <button type="button" key={entry} aria-pressed={mode === entry} onClick={() => setMode(entry)}>{entry === "design" ? "Designer" : entry[0].toUpperCase() + entry.slice(1)}</button>)}</div>
    {mode === "design" ? <DndContext sensors={sensors} onDragEnd={dragEnd}><div className={styles.designer}><aside className={styles.fields} aria-label="Report field list"><h2>Fields</h2><label className={styles.search}><Search size={13} aria-hidden="true" /><input aria-label="Search report fields" placeholder="Search fields…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>{metadataError && <p className={styles.note}>{metadataError}</p>}<p className={styles.note}>Click or press Enter to add a field. Drag onto an item to choose its destination.</p>{fields.filter((field) => field.label.toLowerCase().includes(search.toLowerCase())).map((field) => <DraggableField key={fieldKey(field)} field={field} onAdd={() => addField(field)} />)}<h2>Saved views</h2>{views.filter((view) => view.name.toLowerCase().includes(search.toLowerCase())).map((view) => <button className={styles.field} type="button" key={view.id} onClick={() => addSavedView(view)}><Table2 size={12} aria-hidden="true" />{view.name}</button>)}{!views.length && <p className={styles.note}>Save a view in Explore to use it here.</p>}</aside><section className={styles.canvas} aria-label="Report structure"><div className={styles.canvasToolbar}><span>{document.definition.page.size} · {document.definition.page.orientation} · {document.definition.items.length} items</span><SelectMenu label="Add report item" value="" options={[{ value: "", label: "Add item" }, { value: "table", label: "Table" }, { value: "matrix", label: "Matrix" }, { value: "chart", label: "Chart" }, { value: "text", label: "Text block" }, { value: "pageBreak", label: "Page break" }]} onValueChange={(type) => { if (type) addItem(type as ReportItem["type"]); }} /></div><div className={styles.structurePage}><div className={styles.structureHeader}><h2>{document.definition.header.title || document.name}</h2><p>{document.definition.header.subtitle}</p><p>{document.definition.header.text}</p>{document.definition.header.showParameters && <small>Applied parameters appear here when the report runs.</small>}</div><p id="report-move-help" className={styles.srOnly}>Drag the handle to reorder. With the handle focused, press Up or Down to move one item.</p>{document.definition.items.map((item, index) => <CanvasItem key={item.id} item={item} index={index} count={document.definition.items.length} selected={selectedId === item.id} onSelect={() => setSelectedId(item.id)} onMove={(offset) => move(item.id, offset)} onRemove={() => changeDocument({ ...document, definition: { ...document.definition, items: document.definition.items.filter((entry) => entry.id !== item.id) } })} />)}{!document.definition.items.length && <div className={styles.empty}><Table2 size={28} aria-hidden="true" /><h2>Choose your first field</h2><p>Add a table, matrix, chart, or text block to build this report.</p><Button variant="outline" onClick={() => addItem("table")}>Add table</Button></div>}<div className={styles.structureFooter}>{document.definition.footer.text}{document.definition.footer.showPageNumbers && <span>Page X of Y</span>}</div></div></section><ReportProperties document={document} item={selected} model={model} views={views} onChange={changeDocument} onItemChange={changeItem} /></div></DndContext> : mode === "preview" ? <section><ReportParameters projectId={projectId} definition={document.definition} values={parameters} model={model} onChange={setParameters} /><div className={styles.runToolbar}><span role="status">{running ? `Waiting for the database… · ${(elapsed / 1000).toFixed(1)} s` : run ? `${run.status} · ${(run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000 : elapsed / 1000).toFixed(1)} s` : "No report run selected"}</span><div className={styles.actions}>{running && <Button size="sm" variant="outline" onClick={() => { void cancelRun(); }}>Cancel report</Button>}{run?.status === "succeeded" && (["pdf", "xlsx", "csv"] as const).filter((format) => run.filePaths?.[format]).map((format) => <a className="button button-outline button-sm" key={format} href={`${endpoint}/runs/${run.id}/download?format=${format}`} download><Download size={12} aria-hidden="true" />{format.toUpperCase()}</a>)}</div></div><ReportPreview report={preview} /></section> : mode === "runs" ? <ReportRuns projectId={projectId} reportId={initial.id} refreshToken={refreshToken} onOpenRun={(id) => { setRunId(id); setMode("preview"); }} /> : <ReportSchedules projectId={projectId} reportId={initial.id} definition={document.definition} parameters={parameters} onRunStarted={(id) => { setRunId(id); setMode("preview"); }} />}
  </div>;
}
