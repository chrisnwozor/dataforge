"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatAttribute } from "@/lib/explore/format";
import { cascadeReportParameters } from "@/lib/reports/parameters";
import type { ReportDefinition, ReportParameter, ReportParameterValue, ReportParameterValues } from "@/lib/reports/schema";
import type { QueryFilter, QueryResult, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { reportBody, reportJson } from "./api";
import styles from "./reports.module.css";

function parentFilters(definition: ReportDefinition, values: ReportParameterValues, parameter: ReportParameter): QueryFilter[] {
  const output: QueryFilter[] = []; const seen = new Set<string>();
  let parent = definition.parameters.find((entry) => entry.id === parameter.dependsOn);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id); const value = values[parent.id] ?? parent.default ?? null;
    if (Array.isArray(value)) output.push({ attribute: parent.attribute, op: "in", values: value });
    else if (value !== null && typeof value === "object") { if (value.from !== undefined) output.push({ attribute: parent.attribute, op: "gte", value: value.from }); if (value.to !== undefined) output.push({ attribute: parent.attribute, op: "lte", value: value.to }); }
    else if (value !== null) output.push({ attribute: parent.attribute, op: "eq", value });
    parent = definition.parameters.find((entry) => entry.id === parent!.dependsOn);
  }
  return output;
}

function ValuePicker({ projectId, definition, parameter, values, model, onChange }: { projectId: string; definition: ReportDefinition; parameter: ReportParameter; values: ReportParameterValues; model: SemanticModel | null; onChange: (value: ReportParameterValue) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const current = values[parameter.id] ?? parameter.default ?? null;
  const filters = parentFilters(definition, values, parameter);
  const context = JSON.stringify([parameter.attribute, filters]);
  const column = model?.tables.find((table) => table.id === parameter.attribute.table)?.columns.find((entry) => entry.id === parameter.attribute.column);
  const label = current === null ? "All values" : Array.isArray(current) ? `${current.length} selected` : typeof current === "object" ? "Range" : formatAttribute(current, column);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setError(""); setResult(null);
      reportJson<QueryResult>(`/api/projects/${encodeURIComponent(projectId)}/query`, { ...reportBody({ kind: "values", attribute: parameter.attribute, search: search.trim(), limit: 200, hideUnknown: false, ...(filters.length ? { filters } : {}) }), headers: { "Content-Type": "application/json", "X-DataForge-Query-Purpose": "values" }, signal: controller.signal }).then(setResult).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Values could not be loaded."); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
    // A stable serialized context resets the request after any cascading change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, search, projectId, context]);
  return <div className={styles.parameterPicker}><Button type="button" size="sm" variant="outline" aria-expanded={open} aria-label={`${parameter.name}: ${label}`} onClick={() => setOpen((value) => !value)}>{label}</Button>{open && <div className={styles.parameterValues} role="group" aria-label={`${parameter.name} values`}><input aria-label={`Search ${parameter.name} values`} value={search} maxLength={200} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} onChange={(event) => setSearch(event.target.value)} placeholder="Search values…" /><div className={styles.actions}>{parameter.allowAll && <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>All</Button>}{parameter.type === "multi" && <Button type="button" size="sm" variant="ghost" onClick={() => onChange([])}>None</Button>}<Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Done</Button></div>{error ? <p role="alert" className={styles.error}>{error}</p> : !result ? <p role="status">Loading values…</p> : <div className={styles.valueOptions}>{result.rows.map((row, index) => { const value = row.value ?? null; const selected = Array.isArray(current) ? current.some((entry) => Object.is(entry, value)) : Object.is(current, value); return <label key={index}><input type={parameter.type === "multi" ? "checkbox" : "radio"} name={`report-param-${parameter.id}`} checked={selected} onChange={() => { if (parameter.type === "multi") { const selectedValues: QueryValue[] = Array.isArray(current) ? current : []; onChange(selected ? selectedValues.filter((entry) => !Object.is(entry, value)) : [...selectedValues, value]); } else { onChange(value); setOpen(false); } }} /><span>{formatAttribute(value, column)}</span><small>{Number(row.count ?? 0).toLocaleString()} rows</small></label>; })}{!result.rows.length && <p>No matching values.</p>}</div>}{result?.truncated && <p className={styles.note}>Showing up to 200 matching values. Search to narrow the list.</p>}</div>}</div>;
}

export function ReportParameters({ projectId, definition, values, model, onChange }: { projectId: string; definition: ReportDefinition; values: ReportParameterValues; model: SemanticModel | null; onChange: (values: ReportParameterValues) => void }) {
  if (!definition.parameters.length) return <p className={styles.note}>This report has no parameters. Fixed report filters still apply.</p>;
  const change = (id: string, value: ReportParameterValue) => onChange(cascadeReportParameters(definition, values, id, value));
  return <div className={styles.parameterBar} aria-label="Report parameters">{definition.parameters.map((parameter) => {
    const value = values[parameter.id] ?? parameter.default ?? null;
    if (parameter.type === "single" || parameter.type === "multi") return <div className={styles.parameter} key={parameter.id}><span>{parameter.name}{!parameter.allowAll ? " *" : ""}</span><ValuePicker key={`${parameter.id}:${JSON.stringify(parentFilters(definition, values, parameter))}`} projectId={projectId} definition={definition} parameter={parameter} values={values} model={model} onChange={(next) => change(parameter.id, next)} /></div>;
    if (parameter.type === "dateRange") { const range = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}; return <div className={styles.parameter} key={parameter.id}><span>{parameter.name}</span><div className={styles.dateRange}><input aria-label={`${parameter.name} from`} type="date" value={String(range.from ?? "")} onChange={(event) => change(parameter.id, { ...range, from: event.target.value || undefined })} /><span>to</span><input aria-label={`${parameter.name} to`} type="date" value={String(range.to ?? "")} onChange={(event) => change(parameter.id, { ...range, to: event.target.value || undefined })} /></div></div>; }
    return <label className={styles.parameter} key={parameter.id}>{parameter.name}<input aria-label={`Report parameter ${parameter.name}`} type={parameter.type === "number" ? "number" : "text"} value={value === null ? "" : String(value)} onChange={(event) => change(parameter.id, parameter.type === "number" ? event.target.value === "" ? null : Number(event.target.value) : event.target.value || (parameter.allowAll ? null : ""))} placeholder={parameter.allowAll ? "All values" : "Required"} /></label>;
  })}</div>;
}
