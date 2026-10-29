"use client";

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ArrowLeft, ArrowUpRight, Check, Clock3, Download, Edit3, Expand, GripVertical, LayoutDashboard, Loader2, Maximize2, Plus, Printer, Redo2, RefreshCw, Save, Settings2, Sparkles, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/select-menu";
import { exportChart } from "@/components/charts";
import { attributeKey, createEmptyView } from "@/lib/explore/config";
import { formatValue } from "@/lib/explore/format";
import { affectedTileIds, applicableFilters, mergeDashboardFilters, resolveTileView, toggleCrossFilter } from "@/lib/dashboards/filters";
import { createDashboardHistory, dashboardHistoryReducer } from "@/lib/dashboards/history";
import { appendTile, keyboardTile, moveTile, normalizeLayout, resizeTile } from "@/lib/dashboards/layout";
import { dashboardDocumentSchema, type DashboardDocument, type DashboardTile, type SavedDashboard } from "@/lib/dashboards/schema";
import { generateStarterDashboard } from "@/lib/dashboards/starter";
import type { AttributeRef, QueryFilter } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import type { SavedExploreView } from "@/lib/server/explore-views";
import { DashboardTileContent, DashboardAttributeSlicer, dashboardTileExploreHref } from "./tile-content";
import { DashboardTileSettings } from "./tile-settings";
import { useDashboardQueries } from "./use-dashboard-queries";
import { documentOf, useDashboardSave } from "./use-dashboard-save";
import styles from "./editor.module.css";

const ROW_HEIGHT = 32;
const GRID_GAP = 12;
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || "The dashboard could not be loaded. Try again.");
  return body as T;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "The request could not be completed. Try again."; }

export function DashboardEditor({ projectId, dashboardId }: { projectId: string; dashboardId: string }) {
  const [saved, setSaved] = useState<SavedDashboard | null>(null);
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [views, setViews] = useState<SavedExploreView[]>([]);
  const [lastSuccessfulRunId, setLastSuccessfulRunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [modelError, setModelError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const loadMetadata = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/semantic`, { cache: "no-store", signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "The semantic model could not be loaded.");
    const savedViews = await requestJson<{ views: SavedExploreView[] }>(`/api/projects/${encodeURIComponent(projectId)}/explore/views`, { signal });
    setModel(body); setLastSuccessfulRunId(response.headers.get("X-DataForge-Run-Id")); setViews(savedViews.views); setModelError("");
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<SavedDashboard>(`/api/projects/${encodeURIComponent(projectId)}/dashboards/${encodeURIComponent(dashboardId)}`, { signal: controller.signal }).then(setSaved).catch((failure) => { if (!controller.signal.aborted) setError(errorText(failure)); });
    requestJson<{ views: SavedExploreView[] }>(`/api/projects/${encodeURIComponent(projectId)}/explore/views`, { signal: controller.signal }).then((body) => setViews(body.views)).catch(() => {});
    void Promise.resolve().then(() => loadMetadata(controller.signal)).catch((failure) => { if (!controller.signal.aborted) setModelError(errorText(failure)); });
    return () => controller.abort();
  }, [projectId, dashboardId, loadMetadata, attempt]);
  if (!saved) return <section className={styles.loading} role={error ? undefined : "status"}>{error ? <><LayoutDashboard size={27} aria-hidden="true" /><h1>Dashboard unavailable</h1><p role="alert">{error}</p><div className={styles.actions}><Link href={`/projects/${projectId}/dashboards`} className="button button-outline">All dashboards</Link><Button variant="outline" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Retry</Button></div></> : <><Loader2 className={styles.spin} size={24} aria-hidden="true" /><p>Preparing your dashboard…</p></>}</section>;
  return <DashboardCanvas key={saved.id} projectId={projectId} initial={saved} model={model} views={views} lastSuccessfulRunId={lastSuccessfulRunId} modelError={modelError} onRefresh={loadMetadata} />;
}

interface FrameProps {
  tile: DashboardTile; editing: boolean; selected: boolean; children: ReactNode; footer: ReactNode;
  register: (id: string, element: HTMLElement | null) => void;
  onSelect: () => void; onRemove: () => void; onKeyboard: (event: KeyboardEvent<HTMLButtonElement>, forceResize?: boolean) => void;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void; onResizeMove: (event: PointerEvent<HTMLButtonElement>) => void; onResizeEnd: (event: PointerEvent<HTMLButtonElement>, cancel?: boolean) => void;
}
function TileFrame({ tile, editing, selected, children, footer, register, onSelect, onRemove, onKeyboard, onResizeStart, onResizeMove, onResizeEnd }: FrameProps) {
  const { setNodeRef, attributes, listeners, transform, isDragging } = useDraggable({ id: tile.id, disabled: !editing });
  const attach = useCallback((element: HTMLElement | null) => { setNodeRef(element); register(tile.id, element); }, [setNodeRef, register, tile.id]);
  const style = { gridColumn: `${tile.x + 1} / span ${tile.w}`, gridRow: `${tile.y + 1} / span ${tile.h}`, transform: transform ? `translate3d(${transform.x}px,${transform.y}px,0)` : undefined, zIndex: isDragging ? 20 : undefined, "--mobile-tile-height": `${Math.max(tile.type === "chart" ? 340 : tile.type === "kpi" ? 230 : 180, tile.h * (ROW_HEIGHT + GRID_GAP) - GRID_GAP)}px` } as CSSProperties;
  return <article ref={attach} data-tile-id={tile.id} data-tile-type={tile.type} data-grid-x={tile.x} data-grid-y={tile.y} data-grid-w={tile.w} data-grid-h={tile.h} style={style} className={`${styles.tile} ${selected ? styles.selectedTile : ""} ${isDragging ? styles.draggingTile : ""}`} aria-label={`${tile.title || tile.type} tile`}>
    <div className={styles.tileHeading}>{editing && <button type="button" {...attributes} {...listeners} className={styles.dragHandle} aria-label={`Move ${tile.title || tile.type} tile`} aria-describedby="dashboard-keyboard-help" onKeyDown={onKeyboard}><GripVertical size={14} aria-hidden="true" /></button>}<div><h2>{tile.title || (tile.type === "text" ? "Note" : tile.type === "slicer" ? "Filter" : "Untitled tile")}</h2>{tile.subtitle && <p>{tile.subtitle}</p>}</div>{editing && <div className={styles.tileControls}><button type="button" aria-label={`Settings for ${tile.title || tile.type}`} onClick={onSelect}><Settings2 size={13} aria-hidden="true" /></button><button type="button" aria-label={`Remove ${tile.title || tile.type} tile`} onClick={onRemove}><X size={13} aria-hidden="true" /></button></div>}</div>
    <div className={styles.tileBody} role="region" aria-label={`${tile.title || tile.type} tile content`} tabIndex={0}>{children}</div><div className={styles.tileFooter}>{footer}</div>
    {editing && <button type="button" className={styles.resizeHandle} aria-label={`Resize ${tile.title || tile.type} tile`} aria-describedby="dashboard-keyboard-help" onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={(event) => onResizeEnd(event)} onPointerCancel={(event) => onResizeEnd(event, true)} onKeyDown={(event) => { if (event.key.startsWith("Arrow")) onKeyboard(event, true); }}><Maximize2 size={12} aria-hidden="true" /></button>}
  </article>;
}

function AddTileDialog({ model, views, onAdd, onClose }: { model: SemanticModel | null; views: SavedExploreView[]; onAdd: (tile: DashboardTile) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [kind, setKind] = useState<"chart" | "kpi" | "text" | "slicer">("chart");
  const [search, setSearch] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  const base = () => ({ id: crypto.randomUUID(), x: 0, y: 0, w: kind === "kpi" ? 3 : 6, h: kind === "kpi" ? 5 : kind === "chart" ? 12 : 6, title: "", subtitle: "", numberFormat: "auto" as const, showLegend: true });
  const attributes = model?.tables.flatMap((table) => table.columns.filter((column) => column.role === "attribute").map((column) => ({ value: attributeKey({ table: table.id, column: column.id }), label: `${table.name} · ${column.name}`, attribute: { table: table.id, column: column.id } }))) ?? [];
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={heading} onClose={onClose} onCancel={onClose}><div className={styles.dialogHeading}><h2 id={heading}>Add a tile</h2><Button size="icon" variant="ghost" aria-label="Close add tile" onClick={onClose}><X size={16} /></Button></div><div className={styles.addTypes}>{(["chart", "kpi", "text", "slicer"] as const).map((type) => <button type="button" key={type} aria-pressed={kind === type} onClick={() => setKind(type)}>{type === "kpi" ? "KPI card" : type[0].toUpperCase() + type.slice(1)}</button>)}</div>
    {kind === "chart" ? <><p>Choose a saved Explore view, or start with a simple inline chart.</p><input aria-label="Search saved views" placeholder="Search saved views…" value={search} onChange={(event) => setSearch(event.target.value)} /><div className={styles.viewPicker}>{views.filter((view) => view.name.toLowerCase().includes(search.toLowerCase())).map((view) => <button type="button" key={view.id} onClick={() => onAdd({ ...base(), type: "chart", title: view.name, source: { kind: "view", viewId: view.id } })}><LayoutDashboard size={14} aria-hidden="true" /><span>{view.name}</span><Plus size={13} aria-hidden="true" /></button>)}{!views.length && <p>Save a view in Explore to reuse it here.</p>}</div><Button variant="outline" disabled={!model?.measures.length} onClick={() => { if (!model?.measures.length) return; const config = createEmptyView(); const table = model.tables.find((entry) => entry.kind === "dimension" && entry.columns.some((column) => column.role === "attribute")); const column = table?.columns.find((entry) => entry.role === "attribute"); onAdd({ ...base(), type: "chart", title: model.measures[0].name, source: { kind: "inline", config: { ...config, viz: "bar", values: [model.measures[0].id], rows: table && column ? [{ table: table.id, column: column.id }] : [] } } }); }}>Add an inline chart</Button></> : kind === "kpi" ? <><p>Choose a measure for the full dashboard filter context.</p><div className={styles.viewPicker}>{model?.measures.map((measure) => <button type="button" key={measure.id} onClick={() => onAdd({ ...base(), type: "kpi", title: measure.name, measure: measure.id })}>{measure.name}<Plus size={13} aria-hidden="true" /></button>) ?? <p>Semantic fields are currently unavailable.</p>}</div></> : kind === "text" ? <><p>Add context, definitions, or a note. Text supports simple Markdown and never executes HTML.</p><Button onClick={() => onAdd({ ...base(), type: "text", title: "A note", content: "Add a note about this dashboard." })}>Add text tile</Button></> : <><p>A slicer filters every tile connected to its dimension.</p><div className={styles.viewPicker}>{attributes.map((entry) => <button type="button" key={entry.value} onClick={() => onAdd({ ...base(), type: "slicer", w: 4, h: 5, title: entry.label.split(" · ").at(-1)!, attribute: entry.attribute })}>{entry.label}<Plus size={13} aria-hidden="true" /></button>)}</div>{!attributes.length && <p>Semantic attributes are currently unavailable.</p>}</>}
  </dialog>;
}

function DashboardCanvas({ projectId, initial, model, views, lastSuccessfulRunId, modelError, onRefresh }: { projectId: string; initial: SavedDashboard; model: SemanticModel | null; views: SavedExploreView[]; lastSuccessfulRunId: string | null; modelError: string; onRefresh: () => Promise<void> }) {
  const [history, dispatch] = useReducer(dashboardHistoryReducer, initial, (saved) => createDashboardHistory(documentOf(saved)));
  const doc = history.present;
  const [editing, setEditing] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("edit") === "1");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [presenting, setPresenting] = useState(false);
  const [printPreparing, setPrintPreparing] = useState(false);
  const [printAll, setPrintAll] = useState(false);
  const [filterAttribute, setFilterAttribute] = useState<AttributeRef | null>(null);
  const [preview, setPreview] = useState<DashboardTile[] | null>(null);
  const root = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const resize = useRef<{ id: string; x: number; y: number; w: number; h: number; tiles: DashboardTile[]; next: DashboardTile[] } | null>(null);
  const save = useDashboardSave(projectId, initial, doc);
  const tiles = preview ?? doc.layout.tiles;
  const ordered = useMemo(() => tiles.toSorted((left, right) => left.y - right.y || left.x - right.x || left.id.localeCompare(right.id)), [tiles]);
  const allVisible = useMemo(() => printAll ? doc.layout.tiles.map((tile) => tile.id) : visibleIds, [printAll, doc.layout.tiles, visibleIds]);
  const query = useDashboardQueries({ projectId, model, lastSuccessfulRunId, tiles: doc.layout.tiles, views, filters: doc.filters.items, visibleIds: allVisible, refreshToken });
  const selected = doc.layout.tiles.find((tile) => tile.id === selectedId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const commit = (document: DashboardDocument) => {
    const parsed = dashboardDocumentSchema.safeParse(document);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "This change cannot fit in the dashboard."); return; }
    setError(""); dispatch({ type: "set", document: parsed.data });
  };
  const setTiles = (next: DashboardTile[]) => commit({ ...doc, layout: { version: 1, tiles: next } });
  const setFilters = (filters: QueryFilter[]) => commit({ ...doc, filters: { version: 1, items: filters } });
  const register = useCallback((id: string, element: HTMLElement | null) => { if (element) elements.current.set(id, element); else elements.current.delete(id); }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setVisibleIds(doc.layout.tiles.map((tile) => tile.id)));
      return;
    }
    let live = true;
    const observer = new IntersectionObserver((entries) => {
      if (!live) return;
      setVisibleIds((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.tileId;
          if (id) { if (entry.isIntersecting) next.add(id); else next.delete(id); }
        }
        const ids = [...next].filter((id) => doc.layout.tiles.some((tile) => tile.id === id));
        return ids.length === previous.length && ids.every((id, index) => id === previous[index]) ? previous : ids;
      });
    }, { rootMargin: "160px", threshold: 0 });
    for (const element of elements.current.values()) observer.observe(element);
    return () => { live = false; observer.disconnect(); };
  }, [doc.layout.tiles]);
  useEffect(() => {
    const guardedUrl = location.href;
    const guardedState = window.history.state;
    const hasMetadataDraft = () => {
      const title = root.current?.querySelector<HTMLInputElement>('input[aria-label="Dashboard title"]');
      const description = root.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Dashboard description"]');
      return Boolean((title && title.value.trim() !== doc.name) || (description && description.value !== doc.description));
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (save.dirty || hasMetadataDraft()) { event.preventDefault(); event.returnValue = ""; } };
    const navigate = (event: MouseEvent) => {
      if ((!save.dirty && !hasMetadataDraft()) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.href === location.href) return;
      if (!window.confirm("This dashboard has changes that are still saving. Leave this page and discard unsaved changes?")) { event.preventDefault(); event.stopPropagation(); }
    };
    const back = (event: PopStateEvent) => {
      if (!save.dirty && !hasMetadataDraft()) return;
      if (!window.confirm("This dashboard has unsaved changes. Leave this page and discard them?")) {
        event.stopImmediatePropagation();
        window.history.pushState(guardedState, "", guardedUrl);
      }
    };
    window.addEventListener("beforeunload", beforeUnload); document.addEventListener("click", navigate, true); window.addEventListener("popstate", back, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", navigate, true); window.removeEventListener("popstate", back, true); };
  }, [save.dirty, doc.name, doc.description]);
  useEffect(() => {
    const keys = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") { event.preventDefault(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); setPrintAll(true); setPrintPreparing(true); return; }
      if (event.key === "Escape") { setPresenting(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }
      const input = event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]");
      if (!editing || input || (!event.metaKey && !event.ctrlKey)) return;
      if (event.key.toLowerCase() === "z") { event.preventDefault(); dispatch({ type: event.shiftKey ? "redo" : "undo" }); }
      if (event.key.toLowerCase() === "y") { event.preventDefault(); dispatch({ type: "redo" }); }
    };
    const fullscreen = () => { if (!document.fullscreenElement) setPresenting(false); };
    const printing = () => setPrintAll(true);
    const printed = () => { setPrintAll(false); setPrintPreparing(false); };
    window.addEventListener("keydown", keys); document.addEventListener("fullscreenchange", fullscreen); window.addEventListener("beforeprint", printing); window.addEventListener("afterprint", printed);
    return () => { window.removeEventListener("keydown", keys); document.removeEventListener("fullscreenchange", fullscreen); window.removeEventListener("beforeprint", printing); window.removeEventListener("afterprint", printed); };
  }, [editing]);
  const refresh = useCallback(async () => {
    setRefreshing(true); setError("");
    try { await onRefresh(); setRefreshToken((value) => value + 1); }
    catch (error) { setError(errorText(error)); }
    finally { setRefreshing(false); }
  }, [onRefresh]);
  useEffect(() => {
    if (!doc.settings.autoRefreshMinutes) return;
    const interval = setInterval(() => { void refresh(); }, doc.settings.autoRefreshMinutes * 60_000);
    return () => clearInterval(interval);
  }, [doc.settings.autoRefreshMinutes, refresh]);
  const printableReady = doc.layout.tiles.filter((tile) => tile.type === "chart" || tile.type === "kpi").every((tile) => {
    if (!model) return true;
    const state = query.states[tile.id];
    if (state?.status === "error") return true;
    if (state?.status !== "success") return false;
    if (state.modelVersion !== model.version || state.lastSuccessfulRunId !== lastSuccessfulRunId || state.refreshToken !== refreshToken) return false;
    if (tile.type === "kpi" && (state.kpi?.selection ?? "all") !== (tile.period ?? "all")) return false;
    const view = resolveTileView(tile, views);
    if (!view) return false;
    const config = { ...view, filters: mergeDashboardFilters(view.filters, applicableFilters(tile, model, doc.filters.items, views)), options: { ...view.options, title: tile.title || view.options.title, numberFormat: tile.numberFormat, showLegend: tile.showLegend } };
    return JSON.stringify(state.config) === JSON.stringify(config);
  });
  useEffect(() => {
    if (!printPreparing || !printableReady) return;
    const timer = setTimeout(() => { setPrintPreparing(false); window.print(); }, 150);
    return () => clearTimeout(timer);
  }, [printPreparing, printableReady]);
  const dragEnd = (event: DragEndEvent) => {
    if (!editing || !grid.current) return;
    const tile = doc.layout.tiles.find((entry) => entry.id === event.active.id);
    if (!tile) return;
    const column = (grid.current.clientWidth + GRID_GAP) / 12;
    setTiles(moveTile(doc.layout.tiles, tile.id, tile.x + Math.round(event.delta.x / column), tile.y + Math.round(event.delta.y / (ROW_HEIGHT + GRID_GAP))));
  };
  const resizeStart = (tile: DashboardTile, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { id: tile.id, x: event.clientX, y: event.clientY, w: tile.w, h: tile.h, tiles: doc.layout.tiles, next: doc.layout.tiles };
  };
  const resizeMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!resize.current || !grid.current) return;
    const current = resize.current;
    const column = (grid.current.clientWidth + GRID_GAP) / 12;
    current.next = resizeTile(current.tiles, current.id, current.w + Math.round((event.clientX - current.x) / column), current.h + Math.round((event.clientY - current.y) / (ROW_HEIGHT + GRID_GAP)));
    setPreview(current.next);
  };
  const resizeEnd = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    if (!resize.current) return;
    if (!cancel) setTiles(resize.current.next);
    resize.current = null; setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboardMove = (id: string, event: KeyboardEvent<HTMLButtonElement>, forceResize = false) => { if (!event.key.startsWith("Arrow")) return; event.preventDefault(); event.stopPropagation(); setTiles(keyboardTile(doc.layout.tiles, id, event.key, forceResize || event.shiftKey)); };
  const addTile = (tile: DashboardTile) => { setTiles(appendTile(doc.layout.tiles, tile)); setAdding(false); setSelectedId(tile.id); };
  const attributes = model?.tables.flatMap((table) => table.columns.filter((column) => column.role === "attribute").map((column) => ({ ref: { table: table.id, column: column.id }, label: `${table.name} · ${column.name}` }))) ?? [];
  const label = (ref: AttributeRef) => attributes.find((entry) => attributeKey(entry.ref) === attributeKey(ref))?.label.split(" · ").at(-1) ?? ref.column;
  const filterGroups = [...new Map(doc.filters.items.map((filter) => [attributeKey(filter.attribute), filter.attribute])).values()];
  const summary = (ref: AttributeRef) => doc.filters.items.filter((filter) => attributeKey(filter.attribute) === attributeKey(ref)).map((filter) => filter.op === "in" || filter.op === "notIn" ? `${filter.op === "notIn" ? "excluding " : ""}${filter.values?.map((value) => formatValue(value)).join(", ") || "none"}` : filter.op === "isNull" ? "empty" : `${filter.op} ${formatValue(filter.value)}`).join("; ");
  const enterPresent = async () => { setPresenting(true); setEditing(false); try { await root.current?.requestFullscreen?.(); } catch { /* The CSS presentation works when native fullscreen is unavailable. */ } };
  return <section ref={root} className={`${styles.editor} ${presenting ? styles.presenting : ""}`} data-dashboard-presenting={presenting || undefined} aria-label="Dashboard editor">
    <div className={styles.header}><div className={styles.identity}><Link href={`/projects/${projectId}/dashboards`} className={styles.back}><ArrowLeft size={13} aria-hidden="true" />All dashboards</Link>{editing ? <><h1 className={styles.srOnly}>{doc.name}</h1><input key={doc.name} className={styles.nameInput} aria-label="Dashboard title" defaultValue={doc.name} maxLength={120} onBlur={(event) => { if (event.target.value.trim()) commit({ ...doc, name: event.target.value.trim() }); else event.target.value = doc.name; }} /></> : <h1>{doc.name}</h1>}{editing ? <textarea key={doc.description} aria-label="Dashboard description" className={styles.descriptionInput} defaultValue={doc.description} maxLength={2000} rows={2} placeholder="Add a description…" onBlur={(event) => commit({ ...doc, description: event.target.value })} /> : doc.description && <p>{doc.description}</p>}</div><div className={styles.headerActions}><span className={styles.saveStatus} role="status">{save.status === "saving" ? <Loader2 size={12} className={styles.spin} aria-hidden="true" /> : save.status === "error" ? <Save size={12} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}{save.status === "saved" ? "Saved" : save.status === "saving" ? "Saving…" : "Not saved"}</span><Button size="sm" variant="outline" disabled={refreshing} onClick={() => { void refresh(); }}><RefreshCw size={13} className={refreshing ? styles.spin : undefined} aria-hidden="true" />Refresh</Button>{editing ? <><Button size="icon" variant="ghost" aria-label="Undo dashboard change" disabled={!history.past.length} onClick={() => dispatch({ type: "undo" })}><Undo2 size={15} /></Button><Button size="icon" variant="ghost" aria-label="Redo dashboard change" disabled={!history.future.length} onClick={() => dispatch({ type: "redo" })}><Redo2 size={15} /></Button><Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={doc.layout.tiles.length >= 60}><Plus size={13} aria-hidden="true" />Add tile</Button><Button size="sm" onClick={() => { setEditing(false); setSelectedId(null); }}>Done editing</Button></> : <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Edit3 size={13} aria-hidden="true" />Edit dashboard</Button>}<Button size="sm" variant="ghost" onClick={() => { setPrintAll(true); setPrintPreparing(true); }}><Printer size={13} aria-hidden="true" />Export PDF</Button><Button size="sm" variant="ghost" onClick={() => { void enterPresent(); }}><Expand size={13} aria-hidden="true" />Present</Button></div></div>
    {presenting && <div className={styles.presentControls}><h1>{doc.name}</h1><Button variant="outline" size="sm" onClick={() => { setPresenting(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }}><X size={13} aria-hidden="true" />Exit presentation · Esc</Button></div>}
    {presenting && <p className={styles.presentFilters}>{filterGroups.length ? filterGroups.map((ref) => `${label(ref)}: ${summary(ref)}`).join(" · ") : "No dashboard filters"}</p>}
    <div className={styles.printHeader}><h1>{doc.name}</h1>{doc.description && <p>{doc.description}</p>}<p>Printed {new Date().toLocaleString()} · {filterGroups.length ? filterGroups.map((ref) => `${label(ref)}: ${summary(ref)}`).join(" | ") : "No dashboard filters"}</p>{!printableReady && <p>Some tiles are still loading. For a complete PDF, cancel printing and choose Export PDF.</p>}</div>
    {save.error && <div className={styles.error} role="alert">{save.error}<Button size="sm" variant="outline" onClick={save.retry}>Retry save</Button></div>}{error && <p className={styles.error} role="alert">{error}</p>}{modelError && <p className={styles.warning}>{modelError} Text and layout editing remain available.</p>}
    {printPreparing && <div className={styles.notice} role="status"><Loader2 className={styles.spin} size={14} aria-hidden="true" />Preparing all tiles for print…<Button size="sm" variant="outline" onClick={() => { setPrintPreparing(false); setPrintAll(false); for (const tile of doc.layout.tiles) if (!visibleIds.includes(tile.id)) query.cancel(tile.id); }}>Cancel print preparation</Button></div>}
    <div className={styles.filterBar} aria-label="Dashboard filters"><strong>Filters</strong>{filterGroups.map((ref) => { const affected = model ? affectedTileIds(model, doc.layout.tiles, ref, views) : []; const names = affected.map((id) => doc.layout.tiles.find((tile) => tile.id === id)?.title || id); return <span className={styles.filterChip} key={attributeKey(ref)} title={`Affects: ${names.join(", ") || "no data tiles"}`}><button type="button" onClick={() => setFilterAttribute(ref)}>{label(ref)}: <span>{summary(ref)}</span><small>{affected.length} tiles</small></button><button type="button" aria-label={`Clear ${label(ref)} dashboard filter`} onClick={() => setFilters(doc.filters.items.filter((filter) => attributeKey(filter.attribute) !== attributeKey(ref)))}><X size={12} /></button></span>; })}<SelectMenu label="Add dashboard filter" value="" options={[{ value: "", label: "Add filter…" }, ...attributes.map((entry) => ({ value: attributeKey(entry.ref), label: entry.label }))]} onValueChange={(value) => setFilterAttribute(attributes.find((entry) => attributeKey(entry.ref) === value)?.ref ?? null)} />{filterGroups.length > 0 && <Button size="sm" variant="ghost" onClick={() => setFilters([])}>Clear all</Button>}<div className={styles.dashboardOptions}><label><input type="checkbox" checked={doc.settings.crossFiltering} onChange={(event) => commit({ ...doc, settings: { ...doc.settings, crossFiltering: event.target.checked } })} />Cross-filter charts</label><SelectMenu label="Auto-refresh" value={String(doc.settings.autoRefreshMinutes)} options={[{ value: "0", label: "Auto-refresh off" }, { value: "1", label: "Every minute" }, { value: "5", label: "Every 5 minutes" }, { value: "15", label: "Every 15 minutes" }]} onValueChange={(value) => commit({ ...doc, settings: { ...doc.settings, autoRefreshMinutes: Number(value) as 0 | 1 | 5 | 15 } })} /></div></div>
    {filterAttribute && <div className={styles.filterEditor} role="region" aria-label={`Edit ${label(filterAttribute)} dashboard filter`}><strong>{label(filterAttribute)}</strong><DashboardAttributeSlicer projectId={projectId} model={model} attribute={filterAttribute} filters={doc.filters.items} onChange={setFilters} refreshToken={refreshToken} lastSuccessfulRunId={lastSuccessfulRunId} /><Button size="icon" variant="ghost" aria-label="Close dashboard filter" onClick={() => setFilterAttribute(null)}><X size={14} /></Button></div>}
    {editing && <p id="dashboard-keyboard-help" className={styles.keyboardHelp}>Drag a tile handle to move it. Arrow keys move one grid cell; Shift + arrows resize. Use the corner handle with a mouse or touch.</p>}
    <div className={`${styles.workspace} ${selected && editing ? styles.withSettings : ""}`}><div className={styles.gridWrap}><DndContext sensors={sensors} onDragEnd={dragEnd} accessibility={{ screenReaderInstructions: { draggable: "Use arrow keys to move a tile by one grid cell. Hold Shift with arrows to resize. Pointer users can drag this handle." } }}><div ref={grid} className={styles.grid} aria-label="Dashboard tiles">{ordered.map((tile) => { const state = query.states[tile.id] ?? { status: "idle" as const, elapsedMs: 0 }; const explore = dashboardTileExploreHref(projectId, tile, views, doc.filters.items, model); const affected = model ? applicableFilters(tile, model, doc.filters.items, views).length : 0; return <TileFrame key={tile.id} tile={tile} editing={editing} selected={selectedId === tile.id && editing} register={register} onSelect={() => setSelectedId(tile.id)} onRemove={() => { setTiles(doc.layout.tiles.filter((entry) => entry.id !== tile.id)); if (selectedId === tile.id) setSelectedId(null); }} onKeyboard={(event, forceResize) => keyboardMove(tile.id, event, forceResize)} onResizeStart={(event) => resizeStart(tile, event)} onResizeMove={resizeMove} onResizeEnd={resizeEnd} footer={<><span className={styles.tileStatus}>{tile.type === "chart" || tile.type === "kpi" ? state.status === "success" ? <><Clock3 size={10} aria-hidden="true" />{state.fromCache ? "cached" : `${state.elapsedMs.toLocaleString("en-US", { maximumFractionDigits: 0 })} ms`}</> : state.status === "queued" ? "Queued" : state.status === "loading" ? "Querying…" : state.status === "error" ? "Needs attention" : "Loads when visible" : tile.type === "slicer" ? "Dashboard filter" : "Note"}{affected > 0 && <small> · {affected} {affected === 1 ? "filter" : "filters"}</small>}</span><span className={styles.tileLinks}>{explore && <Link href={explore} target="_blank" aria-label={`Open ${tile.title || tile.type} in Explore`} title="Open in Explore"><ArrowUpRight size={12} aria-hidden="true" /></Link>}{tile.type === "chart" && state.status === "success" && state.config && ["bar", "line", "area", "donut"].includes(state.config.viz) && <button type="button" aria-label={`Export ${tile.title || "chart"} as PNG`} title="Export PNG" onClick={() => { const element = elements.current.get(tile.id); if (element) void exportChart(element, "png", tile.title || "dashboard-chart").catch((failure) => setError(errorText(failure))); }}><Download size={12} aria-hidden="true" /></button>}</span></>}><DashboardTileContent projectId={projectId} tile={tile} model={model} views={views} state={state} affectedTileNames={tile.type === "slicer" && model ? affectedTileIds(model, doc.layout.tiles, tile.attribute, views).map((id) => doc.layout.tiles.find((entry) => entry.id === id)?.title || id) : undefined} filters={doc.filters.items} onFilterChange={setFilters} onMemberClick={doc.settings.crossFiltering ? (attribute, value) => setFilters(toggleCrossFilter(doc.filters.items, attribute, value)) : undefined} onRetry={() => query.retry(tile.id)} onCancel={() => query.cancel(tile.id)} refreshToken={refreshToken} lastSuccessfulRunId={lastSuccessfulRunId} /></TileFrame>; })}</div></DndContext>{!tiles.length && <div className={styles.empty}><LayoutDashboard size={30} aria-hidden="true" /><h2>Make room for the big picture</h2><p>Add a saved chart, a KPI, a note, or a slicer. A starter dashboard can arrange a first set for you.</p><div className={styles.actions}><Button variant="outline" onClick={() => { if (!model) { setError(modelError || "Semantic fields are unavailable. Try Refresh after a successful load."); return; } commit(generateStarterDashboard(model)); setEditing(true); }}><Sparkles size={14} aria-hidden="true" />Generate starter dashboard</Button><Button onClick={() => { setEditing(true); setAdding(true); }}><Plus size={14} aria-hidden="true" />Add tile</Button></div></div>}</div>{selected && editing && <aside className={styles.settings} aria-label="Tile settings"><DashboardTileSettings projectId={projectId} tile={selected} model={model} views={views} filters={doc.filters.items} onChange={(next) => setTiles(normalizeLayout(doc.layout.tiles.map((tile) => tile.id === next.id ? next : tile), next.id))} onClose={() => setSelectedId(null)} /></aside>}</div>
    {adding && <AddTileDialog model={model} views={views} onAdd={addTile} onClose={() => setAdding(false)} />}
  </section>;
}
