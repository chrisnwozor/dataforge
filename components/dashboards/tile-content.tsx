"use client";

import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, ChevronDown, Filter, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExploreResults } from "@/components/explore/results";
import { attributeKey, sameAttribute } from "@/lib/explore/config";
import { formatAttribute, formatMeasure } from "@/lib/explore/format";
import { encodeViewConfig } from "@/lib/explore/url";
import { loadExploreValues } from "@/lib/explore/values";
import { applicableFilters, mergeDashboardFilters, resolveTileView } from "@/lib/dashboards/filters";
import type { DashboardTile } from "@/lib/dashboards/schema";
import type { DashboardTileQueryState } from "@/lib/dashboards/query-controller";
import type { AttributeRef, QueryFilter, QueryResult, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import type { SavedExploreView } from "@/lib/server/explore-views";
import styles from "./tiles.module.css";

function findAttribute(model: SemanticModel | null, attribute: AttributeRef): SemanticColumn | undefined {
  const table = model?.tables.find((entry) => entry.id === attribute.table || entry.name === attribute.table || entry.sqlName === attribute.table);
  return table?.columns.find((entry) => entry.id === attribute.column || entry.name === attribute.column || entry.sqlName === attribute.column);
}

/** Only a deliberately small markdown grammar is interpreted; raw HTML stays escaped text. */
function inlineMarkdown(value: string): ReactNode[] {
  const pattern = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*/g;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index!;
    if (index > offset) nodes.push(value.slice(offset, index));
    const key = `${index}:${match[0]}`;
    nodes.push(match[1] !== undefined ? <strong key={key}>{match[1]}</strong> : match[2] !== undefined ? <code key={key}>{match[2]}</code> : <em key={key}>{match[3]}</em>);
    offset = index + match[0].length;
  }
  if (offset < value.length) nodes.push(value.slice(offset));
  return nodes;
}

export function DashboardText({ content }: { content: string }) {
  const blocks = content.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  return <div className={styles.text}>{blocks.map((block, index) => {
    const lines = block.split("\n");
    if (!block.trim()) return null;
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, ordinal) => <li key={ordinal}>{inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) return <ol key={index}>{lines.map((line, ordinal) => <li key={ordinal}>{inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>)}</ol>;
    if (/^#{1,3}\s+/.test(block) && lines.length === 1) return <h3 key={index}>{inlineMarkdown(block.replace(/^#{1,3}\s+/, ""))}</h3>;
    if (lines.every((line) => /^>\s?/.test(line))) return <blockquote key={index}>{lines.map((line, ordinal) => <Fragment key={ordinal}>{ordinal > 0 && <br />}{inlineMarkdown(line.replace(/^>\s?/, ""))}</Fragment>)}</blockquote>;
    return <p key={index}>{lines.map((line, ordinal) => <Fragment key={ordinal}>{ordinal > 0 && <br />}{inlineMarkdown(line)}</Fragment>)}</p>;
  })}</div>;
}

/** Share the resolved tile context, including currently applicable dashboard filters. */
export function dashboardTileExploreHref(projectId: string, tile: DashboardTile, views: SavedExploreView[], filters: QueryFilter[] = [], model?: SemanticModel | null): string | null {
  const view = resolveTileView(tile, views);
  if (!view) return null;
  const extra = model ? applicableFilters(tile, model, filters, views) : filters;
  const config = { ...view, filters: mergeDashboardFilters(view.filters, extra), options: { ...view.options, title: tile.title || view.options.title, numberFormat: tile.numberFormat, showLegend: tile.showLegend } };
  try { return `/projects/${encodeURIComponent(projectId)}/explore?config=${encodeViewConfig(config)}`; }
  catch { return tile.type === "chart" && tile.source.kind === "view" ? `/projects/${encodeURIComponent(projectId)}/explore?view=${encodeURIComponent(tile.source.viewId)}` : null; }
}

interface TileContentProps {
  projectId: string;
  tile: DashboardTile;
  model: SemanticModel | null;
  views: SavedExploreView[];
  state: DashboardTileQueryState;
  filters: QueryFilter[];
  onFilterChange: (filters: QueryFilter[]) => void;
  onMemberClick?: (attribute: AttributeRef, value: QueryValue) => void;
  onRetry: () => void;
  onCancel?: () => void;
  affectedTileNames?: string[];
  refreshToken?: number;
  lastSuccessfulRunId?: string | null;
}

export function DashboardTileContent({ projectId, tile, model, views, state, filters, onFilterChange, onMemberClick, onRetry, onCancel, affectedTileNames, refreshToken, lastSuccessfulRunId }: TileContentProps) {
  if (tile.type === "text") return <DashboardText content={tile.content} />;
  if (tile.type === "slicer") return <DashboardAttributeSlicer projectId={projectId} model={model} attribute={tile.attribute} filters={filters} onChange={onFilterChange} title={tile.title} affectedTileNames={affectedTileNames} refreshToken={refreshToken} lastSuccessfulRunId={lastSuccessfulRunId} />;
  const resolved = state.config ?? resolveTileView(tile, views);
  if (!model) return <div className={styles.placeholder}><Filter size={19} aria-hidden="true" /><p>Load your warehouse and semantic model to display this tile.</p></div>;
  if (!resolved) return <div className={styles.failure} role="alert"><strong>This saved view is unavailable.</strong><p>Choose another saved view in tile settings. The rest of your dashboard is still available.</p></div>;
  const pending = state.status === "idle" || state.status === "queued" || state.status === "loading";
  const busy = state.status === "queued" || state.status === "loading";
  const config = state.config ?? { ...resolved, options: { ...resolved.options, title: tile.title || resolved.options.title, numberFormat: tile.numberFormat, showLegend: tile.showLegend } };
  const previous = !!state.result && state.status !== "success";
  const tableResult = config.viz === "table" || config.viz === "pivot";
  const displayedKpi = tile.type === "kpi" ? { ...tile, measure: config.values[0] ?? tile.measure, comparisonMeasure: config.values[1], numberFormat: config.options.numberFormat } : null;
  return <div className={styles.content}>
    {state.error && <div className={styles.failure} role="alert"><strong>This tile couldn’t load.</strong><p>{state.error}</p><Button size="sm" variant="outline" onClick={onRetry}><RefreshCw size={12} aria-hidden="true" />Retry tile</Button></div>}
    {state.totalsError && <p className={styles.slicerNote} role="status">{state.totalsError}</p>}
    {busy && state.elapsedMs >= 3000 && <div className={styles.waiting} role="status"><Loader2 size={13} className={styles.spin} aria-hidden="true" /><span>Waiting for the database… · {(state.elapsedMs / 1000).toFixed(1)} s</span>{onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel tile</Button>}</div>}
    {previous && <p className={styles.previous} role="status">Previous result{busy ? " · updating…" : " · retry to update this tile."}</p>}
    {state.result ? displayedKpi ? <KpiValue tile={displayedKpi} model={model} result={state.result} muted={busy} previous={previous} /> : <div className={`${styles.chart} ${tableResult ? styles.tableChart : ""}`}><div className={styles.interactiveResult}><ExploreResults config={config} resultConfig={config} model={model} result={state.result} totals={state.totals} loading={busy} onMemberClick={state.status === "success" ? onMemberClick : undefined} /></div>{tableResult && <DashboardPrintTable result={state.result} config={config} model={model} previous={previous} />}</div> : pending ? <div className={styles.skeleton} role="status" aria-label={`Loading ${tile.title || "dashboard tile"}`}><span /><span /><span /><p>{state.status === "idle" ? "Ready when this tile is visible." : state.status === "queued" ? "Queued for the database…" : "Loading tile…"}</p></div> : !state.error && <div className={styles.placeholder}><p>No result is available yet.</p><Button size="sm" variant="outline" onClick={onRetry}>Load tile</Button></div>}
  </div>;
}

export function DashboardPrintTable({ result, config, model, previous = false }: { result: QueryResult; config: import("@/lib/explore/config").ViewConfig; model: SemanticModel; previous?: boolean }) {
  const columns = result.columns.slice(0, 8);
  const rows = result.rows.slice(0, 15);
  const measureColumns = result.columns.filter((column) => column.role === "measure");
  return <div className={styles.printTable} data-dashboard-print-table="true"><table>
    <caption>{previous ? "Previous result · " : ""}First {rows.length} of {result.rowCount.toLocaleString("en-US")} rows{columns.length < result.columns.length ? ` · first ${columns.length} of ${result.columns.length} columns` : ""}{result.truncated ? " · query result truncated" : ""}. Open in Explore for the full result.</caption>
    <thead><tr>{columns.map((column) => <th scope="col" key={column.key}>{column.name}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => {
      const ordinal = measureColumns.findIndex((entry) => entry.key === column.key);
      const measure = model.measures.find((entry) => entry.id === config.values[ordinal] || entry.name === column.name);
      const label = column.role === "attribute" ? formatAttribute(row[column.key], column) : formatMeasure(row[column.key], config.options.numberFormat === "auto" ? measure?.format ?? "number" : config.options.numberFormat);
      return <td key={column.key}><span>{label}</span></td>;
    })}</tr>)}</tbody>
  </table></div>;
}

function KpiValue({ tile, model, result, muted, previous }: { tile: Extract<DashboardTile, { type: "kpi" }>; model: SemanticModel; result: QueryResult; muted: boolean; previous: boolean }) {
  const measure = model.measures.find((entry) => entry.id === tile.measure || entry.name === tile.measure);
  const comparison = model.measures.find((entry) => entry.id === tile.comparisonMeasure || entry.name === tile.comparisonMeasure);
  const columns = result.columns.filter((column) => column.role === "measure");
  const main = columns.find((column) => column.name === measure?.name) ?? columns[0];
  const secondary = comparison ? columns.find((column) => column.name === comparison.name) : undefined;
  const record = result.rows[0];
  const value = main ? record?.[main.key] : null;
  const compared = secondary ? record?.[secondary.key] : null;
  const positive = typeof compared === "number" && compared > 0;
  const negative = typeof compared === "number" && compared < 0;
  return <div className={`${styles.kpi} ${muted ? styles.mutedKpi : ""}`}>
    <p className={styles.kpiLabel}>{measure?.name ?? tile.measure}</p>
    <div className={styles.kpiValue}>{formatMeasure(value, tile.numberFormat === "auto" ? measure?.format ?? "number" : tile.numberFormat)}</div>
    {comparison && <p className={`${styles.comparison} ${positive ? styles.positive : negative ? styles.negative : ""}`}>{positive ? <ArrowUpRight size={15} aria-hidden="true" /> : negative ? <ArrowDownRight size={15} aria-hidden="true" /> : null}<strong>{formatMeasure(compared, comparison.format)}</strong><span>{comparison.name}</span></p>}
    <p className={styles.kpiContext}>{previous ? "Previous query context" : result.rowCount ? "Current dashboard filter context" : "No data matches the current filters"}</p>
  </div>;
}

export function dashboardFilterSummary(filters: QueryFilter[], column?: Pick<SemanticColumn, "name" | "type">): string {
  if (!filters.length) return "All values";
  const include = filters.find((filter) => filter.op === "in");
  const exclude = filters.find((filter) => filter.op === "notIn");
  const equal = filters.find((filter) => filter.op === "eq");
  if (include) return include.values?.length ? `${include.values.length} selected` : "No values selected";
  if (exclude) return `All except ${exclude.values?.length ?? 0} values`;
  if (equal) return formatAttribute(equal.value, column);
  if (filters.some((filter) => filter.op === "isNull")) return "Empty values";
  const min = filters.find((filter) => filter.op === "gte")?.value;
  const max = filters.find((filter) => filter.op === "lte")?.value;
  return `${min === undefined ? "Any" : formatAttribute(min, column)} → ${max === undefined ? "Any" : formatAttribute(max, column)}`;
}

interface AttributeSlicerProps {
  projectId: string;
  model: SemanticModel | null;
  attribute: AttributeRef;
  filters: QueryFilter[];
  onChange: (filters: QueryFilter[]) => void;
  title?: string;
  inline?: boolean;
  affectedTileNames?: string[];
  refreshToken?: number;
  lastSuccessfulRunId?: string | null;
}

export function DashboardAttributeSlicer({ projectId, model, attribute, filters, onChange, title, inline, affectedTileNames, refreshToken = 0, lastSuccessfulRunId }: AttributeSlicerProps) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const column = findAttribute(model, attribute);
  const applied = filters.filter((filter) => sameAttribute(filter.attribute, attribute));
  const summary = dashboardFilterSummary(applied, column);
  const name = column?.name ?? attribute.column;
  const version = `${model?.version ?? ""}:${lastSuccessfulRunId ?? ""}`;
  return <div className={`${styles.slicer} ${inline ? styles.inlineSlicer : ""}`}>
    {!inline && <p className={styles.slicerLabel}>{title || name}</p>}
    <button type="button" id={triggerId} className={styles.slicerTrigger} aria-label={`Filter ${name}: ${summary}`} aria-expanded={open} disabled={!model || !column} onClick={() => setOpen((value) => !value)}><Filter size={13} aria-hidden="true" /><span>{inline ? `${name}: ${summary}` : summary}</span><ChevronDown size={13} aria-hidden="true" /></button>
    {applied.length > 0 && <button className={styles.clearSlicer} type="button" onClick={() => onChange(filters.filter((filter) => !sameAttribute(filter.attribute, attribute)))}>Clear {name}</button>}
    <p className={styles.slicerNote}>{!model || !column ? "This attribute is unavailable in the current semantic model." : affectedTileNames?.length ? `Affects ${affectedTileNames.join(", ")}.` : affectedTileNames ? "No connected data tiles use this filter." : "Filters connected charts and KPI tiles."}</p>
    <p className={styles.printOnly}>{name}: {summary}</p>
    {open && model && column && <SlicerPopup key={`${attributeKey(attribute)}:${version}`} projectId={projectId} version={version} refreshToken={refreshToken} triggerId={triggerId} attribute={attribute} column={column} applied={applied} onClose={() => setOpen(false)} onApply={(next) => { onChange([...filters.filter((filter) => !sameAttribute(filter.attribute, attribute)), ...next]); setOpen(false); }} />}
  </div>;
}

function SlicerPopup({ projectId, version, refreshToken, triggerId, attribute, column, applied, onClose, onApply }: {
  projectId: string; version: string; refreshToken: number; triggerId: string; attribute: AttributeRef; column: SemanticColumn; applied: QueryFilter[];
  onClose: () => void; onApply: (filters: QueryFilter[]) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancelRequest = useRef<() => void>(() => {});
  const [search, setSearch] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ term: string; result: QueryResult } | null>(null);
  const [failure, setFailure] = useState<{ term: string; message: string } | null>(null);
  const [elapsed, setElapsed] = useState<{ term: string; ms: number }>({ term: "", ms: 0 });
  const [range, setRange] = useState(applied.some((filter) => filter.op === "gte" || filter.op === "lte"));
  const [min, setMin] = useState(String(applied.find((filter) => filter.op === "gte")?.value ?? ""));
  const [max, setMax] = useState(String(applied.find((filter) => filter.op === "lte")?.value ?? ""));
  const [selected, setSelected] = useState<QueryValue[] | null>(() => {
    const inclusion = applied.find((filter) => filter.op === "in");
    const equal = applied.find((filter) => filter.op === "eq");
    return inclusion?.values ?? (equal ? [equal.value ?? null] : applied.some((filter) => filter.op === "isNull") ? [null] : null);
  });
  const [excluded, setExcluded] = useState<QueryValue[]>(() => applied.find((filter) => filter.op === "notIn")?.values ?? []);
  const term = search.trim();
  const result = response?.term === term ? response.result : null;
  const error = failure?.term === term ? failure.message : "";
  useEffect(() => {
    if (range) return;
    const controller = new AbortController();
    let clock: ReturnType<typeof setInterval> | undefined;
    cancelRequest.current = () => { clearInterval(clock); controller.abort(); setFailure({ term, message: "Values request cancelled. Search again or retry." }); };
    const timer = setTimeout(() => {
      setFailure(null);
      const started = performance.now();
      setElapsed({ term, ms: 0 });
      clock = setInterval(() => setElapsed({ term, ms: performance.now() - started }), 100);
      void loadExploreValues(projectId, attribute, { version, search: term, signal: controller.signal, method: "POST", bypassCache: refreshToken > 0 })
        .then((value) => { if (!controller.signal.aborted) setResponse({ term, result: value }); })
        .catch((error: unknown) => { if (!controller.signal.aborted) setFailure({ term, message: error instanceof Error ? error.message : "Values could not be loaded. Try again." }); })
        .finally(() => clearInterval(clock));
    }, 250);
    return () => { clearTimeout(timer); clearInterval(clock); controller.abort(); };
  }, [projectId, attribute, version, term, range, attempt, refreshToken]);
  useEffect(() => {
    const trigger = document.getElementById(triggerId);
    const popup = dialog.current;
    const place = () => {
      if (!popup) return;
      const anchor = trigger?.getBoundingClientRect();
      popup.style.left = `${Math.max(12, Math.min(anchor?.left ?? 12, window.innerWidth - popup.offsetWidth - 12))}px`;
      popup.style.top = `${Math.max(12, Math.min(anchor?.bottom ?? 50, window.innerHeight - popup.offsetHeight - 12))}px`;
    };
    popup?.querySelector<HTMLInputElement>("input")?.focus();
    place();
    const observer = new ResizeObserver(place);
    if (popup) observer.observe(popup);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); if (trigger?.isConnected) trigger.focus(); };
  }, [triggerId]);
  const has = (value: QueryValue) => selected === null ? !excluded.some((item) => Object.is(item, value)) : selected.some((item) => Object.is(item, value));
  const toggle = (value: QueryValue) => {
    if (selected === null) setExcluded(excluded.some((item) => Object.is(item, value)) ? excluded.filter((item) => !Object.is(item, value)) : [...excluded, value]);
    else setSelected(selected.some((item) => Object.is(item, value)) ? selected.filter((item) => !Object.is(item, value)) : [...selected, value]);
  };
  const rangeAllowed = column.type === "number" || column.type === "date";
  const invalidRange = range && ((column.type === "number" && ((min !== "" && !Number.isFinite(Number(min))) || (max !== "" && !Number.isFinite(Number(max))))) || (min !== "" && max !== "" && (column.type === "number" ? Number(min) > Number(max) : min > max)));
  return createPortal(<div className={styles.popover} role="dialog" aria-modal="false" aria-label={`Filter ${column.name}`} ref={dialog} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className={styles.popoverHeading}><strong>{column.name}</strong><button type="button" aria-label="Close slicer" onClick={onClose}><X size={15} aria-hidden="true" /></button></div>
    {rangeAllowed && <div className={styles.slicerTabs}><button type="button" aria-pressed={!range} onClick={() => setRange(false)}>Values</button><button type="button" aria-pressed={range} onClick={() => setRange(true)}>Range</button></div>}
    {range ? <div className={styles.range}><label>From<input type={column.type === "date" ? "date" : "number"} step="any" value={min} onChange={(event) => setMin(event.target.value)} /></label><label>To<input type={column.type === "date" ? "date" : "number"} step="any" value={max} onChange={(event) => setMax(event.target.value)} /></label>{invalidRange && <p role="alert">Enter a valid range with From before To.</p>}</div> : <>
      <input className={styles.valueSearch} aria-label={`Search ${column.name} values`} placeholder="Search all values…" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className={styles.selectionActions}><button type="button" onClick={() => { setSelected(null); setExcluded([]); }}>Select all</button><button type="button" onClick={() => { setSelected([]); setExcluded([]); }}>Select none</button></div>
      <div className={styles.values}>
        {error ? <div role="alert"><p>{error}</p><Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Retry values</Button></div> : !result ? elapsed.term === term && elapsed.ms >= 3000 ? <div role="status"><p>Waiting for the database… · {(elapsed.ms / 1000).toFixed(1)} s</p><Button size="sm" variant="outline" onClick={() => cancelRequest.current()}>Cancel values request</Button></div> : <p role="status">Loading values…</p> : result.rows.length ? result.rows.map((row, index) => <label key={`${JSON.stringify(row.value)}:${index}`}><input type="checkbox" checked={has(row.value)} onChange={() => toggle(row.value)} /><span>{formatAttribute(row.value, column)}</span><small>{Number(row.count ?? 0).toLocaleString()} rows</small></label>) : <p>No matching values.</p>}
      </div>
      {result?.truncated && <p className={styles.slicerNote}>Showing up to 200 matching values. Search to narrow the list, or use a range.</p>}
    </>}
    <div className={styles.slicerFooter}><Button size="sm" variant="outline" onClick={() => onApply([])}>Clear filter</Button><Button size="sm" disabled={!!invalidRange || (!range && (!result || !!error))} onClick={() => {
      if (range) {
        const next: QueryFilter[] = [];
        if (min !== "") next.push({ attribute, op: "gte", value: column.type === "number" ? Number(min) : min });
        if (max !== "") next.push({ attribute, op: "lte", value: column.type === "number" ? Number(max) : max });
        onApply(next);
      } else onApply(selected === null ? excluded.length ? [{ attribute, op: "notIn", values: excluded }] : [] : [{ attribute, op: "in", values: selected }]);
    }}>Apply filter</Button></div>
  </div>, document.fullscreenElement ?? document.body);
}
