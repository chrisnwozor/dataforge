"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/select-menu";
import { attributeKey } from "@/lib/explore/config";
import type { DashboardTile } from "@/lib/dashboards/schema";
import type { SemanticModel } from "@/lib/semantic/types";
import type { QueryFilter } from "@/lib/semantic/query/types";
import type { SavedExploreView } from "@/lib/server/explore-views";
import { dashboardTileExploreHref } from "./tile-content";
import styles from "./tiles.module.css";

interface Props {
  tile: DashboardTile;
  model: SemanticModel | null;
  views: SavedExploreView[];
  onChange: (tile: DashboardTile) => void;
  onClose?: () => void;
  projectId?: string;
  filters?: QueryFilter[];
}

export function DashboardTileSettings({ tile, model, views, onChange, onClose, projectId, filters = [] }: Props) {
  const [search, setSearch] = useState("");
  const measures = model?.measures.map((measure) => ({ value: measure.id, label: measure.name })) ?? [];
  const attributes = model?.tables.flatMap((table) => table.columns.filter((column) => column.role === "attribute").map((column) => ({ ref: { table: table.id, column: column.id }, label: `${table.name} · ${column.name}` }))) ?? [];
  const href = projectId ? dashboardTileExploreHref(projectId, tile, views, filters, model) : null;
  return <div className={styles.settings}>
    <div className={styles.settingsHeading}><div><span className={styles.eyebrow}>{tile.type.toUpperCase()} TILE</span><h2>Tile settings</h2></div>{onClose && <Button size="icon" variant="ghost" aria-label="Close tile settings" onClick={onClose}><X size={15} aria-hidden="true" /></Button>}</div>
    <label className={styles.control}>Title<input value={tile.title} maxLength={200} onChange={(event) => onChange({ ...tile, title: event.target.value })} placeholder="Automatic title" /></label>
    <label className={styles.control}>Subtitle<input value={tile.subtitle} maxLength={500} onChange={(event) => onChange({ ...tile, subtitle: event.target.value })} placeholder="Optional context" /></label>
    {(tile.type === "chart" || tile.type === "kpi") && <div className={styles.control}><span>Number format</span><SelectMenu label="Tile number format" value={tile.numberFormat} options={[{ value: "auto", label: "From each measure" }, { value: "number", label: "Number" }, { value: "currency", label: "Currency" }, { value: "percent", label: "Percent" }, { value: "decimals", label: "2 decimal places" }]} onValueChange={(value) => onChange({ ...tile, numberFormat: value as DashboardTile["numberFormat"] })} /></div>}
    {tile.type === "chart" && <>
      <label className={styles.checkControl}><input type="checkbox" checked={tile.showLegend} onChange={(event) => onChange({ ...tile, showLegend: event.target.checked })} />Show legend</label>
      {tile.source.kind === "inline" && <div className={styles.control}><span>Visualization</span><SelectMenu label="Tile visualization" value={tile.source.config.viz} options={[{ value: "table", label: "Table" }, { value: "pivot", label: "Pivot" }, { value: "bar", label: "Bar" }, { value: "line", label: "Line" }, { value: "area", label: "Area" }, { value: "donut", label: "Donut" }, { value: "kpi", label: "KPI cards" }]} onValueChange={(viz) => { if (tile.source.kind === "inline") onChange({ ...tile, source: { ...tile.source, config: { ...tile.source.config, viz: viz as typeof tile.source.config.viz } } }); }} /></div>}
      <h3>Saved view</h3>
      <label className={styles.settingsSearch}><Search size={13} aria-hidden="true" /><input aria-label="Search saved views for tile" placeholder="Search saved views…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className={styles.viewChoices} role="group" aria-label="Saved views for tile">{views.filter((view) => view.name.toLowerCase().includes(search.toLowerCase())).map((view) => <button type="button" key={view.id} aria-pressed={tile.source.kind === "view" && tile.source.viewId === view.id} onClick={() => onChange({ ...tile, source: { kind: "view", viewId: view.id } })}><span>{view.name}</span>{tile.source.kind === "view" && tile.source.viewId === view.id && <Check size={13} aria-hidden="true" />}</button>)}{!views.length && <p>Save a view in Explore to add it here.</p>}{views.length > 0 && !views.some((view) => view.name.toLowerCase().includes(search.toLowerCase())) && <p>No matching saved views.</p>}</div>
    </>}
    {tile.type === "kpi" && <>
      <div className={styles.control}><span>Measure</span>{measures.length ? <SelectMenu label="KPI measure" value={tile.measure} options={measures} onValueChange={(measure) => onChange({ ...tile, measure, comparisonMeasure: tile.comparisonMeasure === measure ? undefined : tile.comparisonMeasure })} /> : <p>No semantic measures are available yet.</p>}</div>
      <div className={styles.control}><span>Period</span><SelectMenu label="KPI period" value={tile.period ?? "all"} options={[{ value: "all", label: "All time" }, { value: "latestYear", label: "Latest year" }, { value: "latestQuarter", label: "Latest quarter" }, { value: "latestMonth", label: "Latest month" }]} onValueChange={(period) => onChange({ ...tile, period: period as Extract<DashboardTile, { type: "kpi" }>["period"] })} /></div>
      <div className={styles.control}><span>Comparison measure</span><SelectMenu label="KPI comparison" value={tile.comparisonMeasure ?? ""} options={[{ value: "", label: "No comparison" }, ...measures.filter((measure) => measure.value !== tile.measure)]} onValueChange={(comparisonMeasure) => onChange({ ...tile, comparisonMeasure: comparisonMeasure || undefined })} /></div>
      <p className={styles.settingsNote}>{model?.date ? "The big number uses the selected period. All time keeps every dashboard filter. Latest-period values and comparisons replace calendar filters with the latest complete year, quarter, or month in the data, preserve other filters, and show their periods explicitly." : "Period selection and time comparisons require a date dimension. Comparisons are hidden until one is available."}</p>
    </>}
    {tile.type === "text" && <><label className={styles.control}>Text content<textarea aria-label="Text content" value={tile.content} maxLength={20_000} rows={10} onChange={(event) => onChange({ ...tile, content: event.target.value })} placeholder="Write a note, **highlight** an idea, or add a short list." /></label><p className={styles.settingsNote}>Supports headings, lists, **bold**, *emphasis*, and `code`. HTML is displayed as plain text.</p></>}
    {tile.type === "slicer" && <><div className={styles.control}><span>Attribute</span>{attributes.length ? <SelectMenu label="Slicer attribute" value={attributeKey(tile.attribute)} options={attributes.map(({ ref, label }) => ({ value: attributeKey(ref), label }))} onValueChange={(key) => { const entry = attributes.find(({ ref }) => attributeKey(ref) === key); if (entry) onChange({ ...tile, attribute: entry.ref }); }} /> : <p>No semantic attributes are available yet.</p>}</div><p className={styles.settingsNote}>Slicer values load when opened. Its selection filters all connected data tiles.</p></>}
    {href && <Link href={href} className="button button-outline">Open in Explore<ArrowUpRight size={13} aria-hidden="true" /></Link>}
  </div>;
}
