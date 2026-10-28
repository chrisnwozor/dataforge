"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CalendarDays, ChevronRight, GripVertical, Search, Sigma, Table2, Type } from "lucide-react";
import type { AttributeRef } from "@/lib/semantic/query/types";
import type { SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import styles from "../explore-workspace.module.css";

export type ExploreField = { kind: "measure"; field: string; label: string } | { kind: "attribute"; field: AttributeRef; label: string };

export function FieldItem({ item, onAdd, uniqueId }: { item: ExploreField; onAdd: (item: ExploreField) => void; uniqueId: string }) {
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: uniqueId, data: item });
  return <button type="button" ref={setNodeRef} {...listeners} {...attributes} className={styles.field} style={{ opacity: isDragging ? 0.4 : 1 }} onClick={() => { if (!isDragging) onAdd(item); }} aria-label={`Add ${item.label} to ${item.kind === "measure" ? "Values" : "Rows"}`} title={`Click or press Enter to add. Press Space to drag ${item.label}.`}>
    <GripVertical size={12} aria-hidden="true" />{item.kind === "measure" ? <Sigma size={13} aria-hidden="true" /> : <Type size={13} className={styles.attributeIcon} aria-hidden="true" />}<span>{item.label}</span><span className={styles.addHint} aria-hidden="true">+</span>
  </button>;
}

export function ExploreFields({ model, onAdd }: { model: SemanticModel; onAdd: (field: ExploreField) => void }) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search).trim().toLocaleLowerCase();
  const folders = useMemo(() => {
    const grouped = new Map<string, typeof model.measures>();
    for (const measure of model.measures) {
      if (query && !`${measure.name} ${measure.folder}`.toLocaleLowerCase().includes(query)) continue;
      const folder = measure.folder || "Measures";
      grouped.set(folder, [...(grouped.get(folder) ?? []), measure]);
    }
    return [...grouped];
  }, [model, query]);
  const matches = (column: SemanticColumn, tableName: string) => !query || `${column.name} ${tableName}`.toLocaleLowerCase().includes(query);
  return <aside className={styles.fields} aria-label="Field list">
    <div className={styles.panelHeading}><strong>Fields</strong><span>{model.measures.length} measures</span></div>
    <label className={styles.search}><Search size={14} aria-hidden="true" /><input aria-label="Search fields" placeholder="Search fields…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className={styles.fieldScroll}>
      <div className={styles.sectionCaption}>MEASURES</div>
      {folders.map(([folder, measures]) => <details key={folder} open className={styles.fieldGroup}><summary><ChevronRight size={12} aria-hidden="true" />{folder}<span>{measures.length}</span></summary><div>{measures.map((measure) => <FieldItem key={measure.id} uniqueId={`measure:${measure.id}`} item={{ kind: "measure", field: measure.id, label: measure.name }} onAdd={onAdd} />)}</div></details>)}
      <div className={styles.sectionCaption}>DIMENSIONS</div>
      {model.tables.filter((table) => table.kind === "dimension").map((table) => {
        const attributes = table.columns.filter((column) => column.role === "attribute" && matches(column, table.name));
        if (!attributes.length) return null;
        return <details key={table.id} open className={styles.fieldGroup}><summary><ChevronRight size={12} aria-hidden="true" /><Table2 size={12} aria-hidden="true" />{table.name}</summary><div>
          {model.hierarchies.filter((hierarchy) => hierarchy.tableId === table.id).map((hierarchy) => {
            const levels = hierarchy.levels.map((id) => table.columns.find((column) => column.id === id)).filter((column): column is SemanticColumn => Boolean(column));
            return <details key={hierarchy.id} className={styles.hierarchy}><summary><CalendarDays size={12} aria-hidden="true" />{hierarchy.name}</summary>{levels.map((column, index) => <div key={column.id} style={{ paddingLeft: index * 9 }}><FieldItem uniqueId={`hierarchy:${hierarchy.id}:${column.id}`} item={{ kind: "attribute", field: { table: table.id, column: column.id }, label: column.name }} onAdd={onAdd} />{index < levels.length - 1 && <span className={styles.hierarchyConnector} aria-hidden="true">↓</span>}</div>)}</details>;
          })}
          {attributes.map((column) => <FieldItem key={column.id} uniqueId={`attribute:${column.id}`} item={{ kind: "attribute", field: { table: table.id, column: column.id }, label: column.name }} onAdd={onAdd} />)}
        </div></details>;
      })}
      {!folders.length && !model.tables.some((table) => table.kind === "dimension" && table.columns.some((column) => column.role === "attribute" && matches(column, table.name))) && <p className={styles.small}>No matching fields.</p>}
    </div>
    <p className={styles.fieldHelp}>Click a field to add it. Drag to a shelf, or press Space to move it with the keyboard.</p>
  </aside>;
}
