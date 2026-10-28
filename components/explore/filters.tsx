"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Filter, X } from "lucide-react";
import type { SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import type { AttributeRef, QueryFilter, QueryResult, QueryValue } from "@/lib/semantic/query/types";
import { attributeKey } from "@/lib/explore/config";
import { formatAttribute } from "@/lib/explore/format";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import styles from "./filters.module.css";

const valueCache = new Map<string, { expires: number; promise: Promise<QueryResult> }>();
function distinctValues(projectId: string, attribute: AttributeRef, version = ""): Promise<QueryResult> {
  const key = `${projectId}:${version}:${attributeKey(attribute)}`;
  const cached = valueCache.get(key);
  let promise = cached && cached.expires > Date.now() ? cached.promise : undefined;
  if (!promise) {
    promise = fetch(`/api/projects/${encodeURIComponent(projectId)}/query/values?${new URLSearchParams({ attribute: JSON.stringify(attribute) })}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Values could not be loaded. Try again.");
        return body as QueryResult;
      }).catch((error: unknown) => { valueCache.delete(key); throw error; });
    if (valueCache.size >= 64) valueCache.delete(valueCache.keys().next().value!);
    valueCache.set(key, { expires: Date.now() + 60_000, promise });
  }
  return promise;
}

/** Warm only the first few slicers; this shares the exact values API used on open. */
export function prefetchExploreValues(projectId: string, refs: AttributeRef[], version = ""): void {
  for (const ref of refs.slice(0, 3)) void distinctValues(projectId, ref, version).catch(() => {});
}

type TopN = { measure: string; n: number };
interface Props {
  projectId: string;
  model: SemanticModel;
  filters: QueryFilter[];
  onChange: (filters: QueryFilter[]) => void;
  topN?: TopN;
  onTopNChange: (topN?: TopN) => void;
  requestedAttribute?: AttributeRef | null;
  onRequestedAttributeHandled?: () => void;
}

export function ExploreFilters({ projectId, model, filters, onChange, topN, onTopNChange, requestedAttribute, onRequestedAttributeHandled }: Props) {
  const addFilterId = useId();
  const attributes = useMemo(() => model.tables.flatMap((table) => table.columns
    .filter((column) => column.role === "attribute")
    .map((column) => ({ ref: { table: table.id, column: column.id }, column, tableName: table.name }))), [model]);
  const [editing, setEditing] = useState<AttributeRef | null>(null);
  // A new dropped attribute mounts its editor without mutating the query until Apply.
  const active = requestedAttribute ?? editing;
  const selected = attributes.find(({ ref }) => active && attributeKey(ref) === attributeKey(active));
  const filterAttributes = [...new Map(filters.map((filter) => [attributeKey(filter.attribute), filter.attribute])).values()];
  const [adding, setAdding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = () => {
    setEditing(null);
    if (requestedAttribute) onRequestedAttributeHandled?.();
  };

  return <div className={styles.root} ref={root} onKeyDown={(event) => {
    if (event.key === "Escape") { close(); setAdding(false); }
  }}>
    <span className={styles.label}><Filter size={13} aria-hidden="true" /> Filters</span>
    {filterAttributes.map((ref) => {
      const match = attributes.find((entry) => attributeKey(entry.ref) === attributeKey(ref));
      const applied = filters.filter((filter) => attributeKey(filter.attribute) === attributeKey(ref));
      const label = match?.column.name ?? ref.column;
      const inclusion = applied.find((filter) => filter.op === "in");
      const exclusion = applied.find((filter) => filter.op === "notIn");
      const equals = applied.find((filter) => filter.op === "eq");
      const summary = inclusion ? `${inclusion.values!.length} selected` : exclusion ? `${exclusion.values!.length} excluded` : equals ? formatAttribute(equals.value, match?.column) : applied.some((filter) => filter.op === "isNull") ? "empty" : "range";
      return <span key={attributeKey(ref)} className={styles.chip}>
        <button type="button" aria-label={`Edit ${label} filter`} onClick={() => setEditing(ref)}>{label} <span className={styles.muted}>{summary}</span></button>
        <button type="button" aria-label={`Remove ${label} filter`} onClick={() => onChange(filters.filter((filter) => attributeKey(filter.attribute) !== attributeKey(ref)))}><X size={12} /></button>
      </span>;
    })}
    <div className={styles.anchor}>
      <DropdownMenu open={adding} onOpenChange={setAdding}>
        <DropdownMenuTrigger asChild><button type="button" id={addFilterId} className={styles.add}>Add filter <ChevronDown size={12} /></button></DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Choose filter attribute" onCloseAutoFocus={(event) => { if (editing) event.preventDefault(); }}>
          <DropdownMenuRadioGroup value="" onValueChange={(key) => { const entry = attributes.find(({ ref }) => attributeKey(ref) === key); if (entry) setEditing(entry.ref); }}>
            {attributes.map(({ ref, column, tableName }) => <DropdownMenuRadioItem key={attributeKey(ref)} value={attributeKey(ref)}><span>{column.name}</span><small className={styles.tableName}>{tableName}</small></DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          {!attributes.length && <p>No dimension attributes available.</p>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <TopNControl key={`${topN?.measure}:${topN?.n}`} model={model} topN={topN} onChange={onTopNChange} />
    {selected && active && <Slicer key={attributeKey(active)} projectId={projectId} version={model.version} triggerId={addFilterId} attribute={active} column={selected.column} filters={filters} onApply={(next) => {
      onChange([...filters.filter((filter) => attributeKey(filter.attribute) !== attributeKey(active)), ...next]); close();
    }} onClose={close} />}
  </div>;
}

function Slicer({ projectId, version, triggerId, attribute, column, filters, onApply, onClose }: {
  projectId: string; version: string; triggerId: string; attribute: AttributeRef; column: SemanticColumn; filters: QueryFilter[];
  onApply: (filters: QueryFilter[]) => void; onClose: () => void;
}) {
  const applied = filters.filter((filter) => attributeKey(filter.attribute) === attributeKey(attribute));
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<QueryValue[] | null>(() => {
    const include = applied.find((filter) => filter.op === "in");
    const equals = applied.find((filter) => filter.op === "eq");
    return include?.values ?? (equals ? [equals.value ?? null] : applied.some((filter) => filter.op === "isNull") ? [null] : null);
  });
  const [excluded, setExcluded] = useState<QueryValue[]>(() => {
    const exclude = applied.find((filter) => filter.op === "notIn");
    const unequal = applied.find((filter) => filter.op === "ne");
    return exclude?.values ?? (unequal ? [unequal.value ?? null] : []);
  });
  const [min, setMin] = useState(String(applied.find((filter) => filter.op === "gte")?.value ?? ""));
  const [max, setMax] = useState(String(applied.find((filter) => filter.op === "lte")?.value ?? ""));
  const [range, setRange] = useState(applied.some((filter) => filter.op === "gte" || filter.op === "lte"));
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const trigger = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : document.getElementById(triggerId);
    void distinctValues(projectId, attribute, version).then((value) => { if (live) setResult(value); }).catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : "Values could not be loaded."); });
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const place = () => {
      const popup = dialog.current;
      if (!popup) return;
      const anchor = trigger instanceof HTMLElement ? trigger.getBoundingClientRect() : null;
      popup.style.left = `${Math.max(12, Math.min(anchor?.left ?? 12, window.innerWidth - popup.offsetWidth - 12))}px`;
      popup.style.top = `${Math.max(12, Math.min(anchor?.bottom ?? 60, window.innerHeight - popup.offsetHeight - 12))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    if (dialog.current) observer.observe(dialog.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      live = false;
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer.disconnect();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      else document.getElementById(triggerId)?.focus();
    };
  }, [projectId, attribute, version, triggerId]);
  const values = result?.rows.filter((row) => formatAttribute(row.value, column).toLowerCase().includes(search.toLowerCase())) ?? [];
  const has = (value: QueryValue) => selected === null ? !excluded.some((candidate) => Object.is(candidate, value)) : selected.some((candidate) => Object.is(candidate, value));
  const toggle = (value: QueryValue) => {
    if (selected === null) setExcluded(excluded.some((candidate) => Object.is(candidate, value)) ? excluded.filter((candidate) => !Object.is(candidate, value)) : [...excluded, value]);
    else setSelected(selected.some((candidate) => Object.is(candidate, value)) ? selected.filter((candidate) => !Object.is(candidate, value)) : [...selected, value]);
  };
  const isRange = column.type === "number" || column.type === "date";
  const invalidRange = range && ((column.type === "number" && ((min !== "" && !Number.isFinite(Number(min))) || (max !== "" && !Number.isFinite(Number(max))))) || (min !== "" && max !== "" && (column.type === "number" ? Number(min) > Number(max) : min > max)));
  return createPortal(<div className={styles.popover} role="dialog" aria-modal="false" aria-label={`Filter ${column.name}`} ref={dialog}>
    <div className={styles.heading}><strong>{column.name}</strong><button type="button" aria-label="Close filter" onClick={onClose}><X size={15} /></button></div>
    {isRange && <div className={styles.tabs}><button type="button" aria-pressed={!range} onClick={() => setRange(false)}>Values</button><button type="button" aria-pressed={range} onClick={() => setRange(true)}>Range</button></div>}
    {range ? <div className={styles.range}>
      <label>From<input type={column.type === "date" ? "date" : "number"} step="any" value={min} onChange={(event) => setMin(event.target.value)} /></label>
      <label>To<input type={column.type === "date" ? "date" : "number"} step="any" value={max} onChange={(event) => setMax(event.target.value)} /></label>
      {invalidRange && <p role="alert">Enter a valid range with From before To.</p>}
    </div> : <>
      <input aria-label={`Search ${column.name} values`} placeholder="Search values…" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className={styles.actions}><button type="button" onClick={() => { setSelected(null); setExcluded([]); }}>Select all</button><button type="button" onClick={() => { setSelected([]); setExcluded([]); }}>Select none</button></div>
      <div className={styles.values}>
        {error ? <p role="alert">{error}</p> : !result ? <p role="status">Loading values…</p> : values.length ? values.map((row, index) => <label key={`${JSON.stringify(row.value)}:${index}`}><input type="checkbox" checked={has(row.value)} onChange={() => toggle(row.value)} /><span>{formatAttribute(row.value, column)}</span><small>{Number(row.count ?? 0).toLocaleString()} rows</small></label>) : <p>No matching values.</p>}
      </div>
      {result?.truncated && <p className={styles.note}>Showing the first 1,000 values. Search applies to these values; use a range for a larger selection.</p>}
    </>}
    <div className={styles.footer}><button type="button" className="button button-secondary" onClick={() => onApply([])}>Clear</button><button type="button" className="button button-primary" disabled={!!invalidRange || (!range && !result)} onClick={() => {
      if (range) {
        const next: QueryFilter[] = [];
        if (min !== "") next.push({ attribute, op: "gte", value: column.type === "number" ? Number(min) : min });
        if (max !== "") next.push({ attribute, op: "lte", value: column.type === "number" ? Number(max) : max });
        onApply(next);
      } else onApply(selected === null ? excluded.length ? [{ attribute, op: "notIn", values: excluded }] : [] : [{ attribute, op: "in", values: selected }]);
    }}>Apply filter</button></div>
  </div>, document.body);
}

export function TopNControl({ model, topN, onChange }: { model: SemanticModel; topN?: TopN; onChange: (topN?: TopN) => void }) {
  const groupId = useId();
  const [n, setN] = useState(String(topN?.n ?? 10));
  const [measure, setMeasure] = useState(topN?.measure ?? model.measures[0]?.id ?? "");
  return <details className={styles.topN}>
    <summary>Top N{topN ? ` · ${topN.n}` : ""}</summary>
    <div className={styles.topNBody}>
      <label>Number of results<input aria-label="Top N count" type="number" min={1} max={50000} value={n} onChange={(event) => setN(event.target.value)} /></label>
      <fieldset><legend>Rank by measure</legend>{model.measures.map((entry) => <label key={entry.id}><input type="radio" name={groupId} value={entry.id} checked={measure === entry.id} onChange={() => setMeasure(entry.id)} />{entry.name}</label>)}</fieldset>
      <div className={styles.footer}><button type="button" className="button button-secondary" onClick={() => onChange(undefined)}>Clear Top N</button><button type="button" className="button button-primary" disabled={!measure || !Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 50000} onClick={(event) => { onChange({ measure, n: Number(n) }); event.currentTarget.closest("details")?.removeAttribute("open"); }}>Apply Top N</button></div>
    </div>
  </details>;
}
