"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, FileJson, FileSpreadsheet, Loader2, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SourceDialogMenu } from "./source-dialog-menu";
import type { PipelineDefinition } from "@/lib/prepare/schema";
import styles from "./sources.module.css";

export interface SourceColumn { name: string; type?: string }
export interface SourceRecord {
  id: string; projectId: string; name: string; kind: "csv" | "xlsx" | "json";
  options: { version: 1; delimiter?: string; sheetName?: string; headerRow?: number; jsonArrayPath?: string; arraySeparator?: string };
  rowCount: number; columns: SourceColumn[]; createdAt: string;
}
interface SavedPipeline { version: number; definition: PipelineDefinition }
interface SourceChange { sources?: SourceRecord[]; source?: SourceRecord; warnings?: string[]; affectedSteps?: { id: string; name: string; missingColumns: string[] }[] }
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

async function sourceJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "This source could not be updated. Try again.");
  return body as T;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "This source could not be loaded. Try again.";
export const sourceColumnNames = (columns: readonly (SourceColumn | string)[]) => columns.map((column) => typeof column === "string" ? column : column.name);

export function SourceManager({ projectId }: { projectId: string }) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/sources`;
  const pipelineUrl = `/api/projects/${encodeURIComponent(projectId)}/pipeline`;
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [pipeline, setPipeline] = useState<SavedPipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string[]>([]);
  const [uploading, setUploading] = useState<SourceRecord | "new" | null>(null);
  const [renaming, setRenaming] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      sourceJson<{ sources: SourceRecord[] }>(endpoint, { signal: controller.signal }).then((body) => { if (!controller.signal.aborted) setSources(body.sources); }),
      sourceJson<SavedPipeline>(pipelineUrl, { signal: controller.signal }).then((body) => { if (!controller.signal.aborted) setPipeline(body); }),
    ]).then((results) => { if (controller.signal.aborted) return; if (results[0].status === "rejected") setError(errorMessage(results[0].reason)); setLoading(false); });
    return () => controller.abort();
  }, [endpoint, pipelineUrl, attempt]);
  const reload = () => setAttempt((value) => value + 1);
  const changed = (body: SourceChange) => {
    const affected = body.affectedSteps?.map((step) => `${step.name}: missing ${step.missingColumns.join(", ")}. Review this step in Prepare.`) ?? [];
    setNotice([...(body.warnings ?? []), ...affected]); setError(""); setUploading(null); reload();
  };
  const rename = async (source: SourceRecord) => {
    setBusy(source.id); setError("");
    try { await sourceJson(`${endpoint}/${encodeURIComponent(source.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }); setRenaming(""); reload(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };
  const remove = async (source: SourceRecord) => {
    if (!window.confirm(`Remove “${source.name}” and its file from this project?`)) return;
    setBusy(source.id); setError("");
    try { const response = await fetch(`${endpoint}/${encodeURIComponent(source.id)}`, { method: "DELETE" }); if (!response.ok) throw new Error((await response.json()).error || "The source could not be removed."); setSources((current) => current.filter((entry) => entry.id !== source.id)); if (preview === source.id) setPreview(""); reload(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };
  const makeMain = async (source: SourceRecord) => {
    if (!pipeline) return;
    setBusy(source.id); setError("");
    try { await sourceJson(pipelineUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: { ...pipeline.definition, mainSourceId: source.id }, version: pipeline.version }) }); setNotice(["Main input changed. Review the pipeline's column references in Prepare while its new profile is built."]); reload(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(""); }
  };
  return <section aria-label="Project sources" className={styles.manager}>
    <div className={styles.toolbar}><p>The main input starts your pipeline. Other files are available to Join, Lookup, and Union steps.</p><Button onClick={() => setUploading("new")}><Plus size={14} aria-hidden="true" />Add source</Button></div>
    {error && <div className={styles.error} role="alert"><p>{error}</p><Button variant="outline" size="sm" onClick={() => { setError(""); reload(); }}>Retry sources</Button></div>}
    {notice.length > 0 && <div className={styles.notice} role="status"><div>{notice.map((message, index) => <p key={index}>{message}</p>)}</div><Button size="icon" variant="ghost" aria-label="Dismiss source notices" onClick={() => setNotice([])}><X size={13} aria-hidden="true" /></Button></div>}
    {loading ? <div className={styles.empty} role="status"><Loader2 size={23} aria-hidden="true" /><p>Loading sources…</p></div> : !sources.length ? <div className={styles.empty}><FileSpreadsheet size={30} aria-hidden="true" /><h2>Add the files behind your model</h2><p>Upload CSV, Excel, or JSON, then connect and prepare them before profiling.</p><Button onClick={() => setUploading("new")}><Upload size={14} aria-hidden="true" />Add your first source</Button></div> : <div className={styles.list}>{sources.map((source) => {
      const main = source.id === pipeline?.definition.mainSourceId;
      const used = pipeline?.definition.steps.filter((step) => "sourceId" in step && step.sourceId === source.id).map((step) => step.name) ?? [];
      const protectedSource = main || used.length > 0;
      const SourceIcon = source.kind === "json" ? FileJson : FileSpreadsheet;
      return <article className={styles.card} key={source.id} data-source-id={source.id}>
        <div className={styles.cardHeader}><span className={styles.sourceIcon}><SourceIcon size={20} aria-hidden="true" /></span><div className={styles.sourceIdentity}>{renaming === source.id ? <form className={styles.rename} aria-label={`Rename ${source.name}`} onSubmit={(event) => { event.preventDefault(); void rename(source); }}><input aria-label="Source name" value={name} maxLength={120} required autoFocus onChange={(event) => setName(event.target.value)} /><Button size="sm" type="submit" disabled={busy === source.id}>Save name</Button><Button type="button" size="sm" variant="ghost" onClick={() => setRenaming("")}>Cancel</Button></form> : <><h2>{source.name}</h2><p>{source.kind.toUpperCase()} · {source.rowCount.toLocaleString()} rows · {source.columns.length.toLocaleString()} columns{source.options.sheetName ? ` · ${source.options.sheetName}` : ""}</p></>}</div>{main && <span className={styles.mainBadge}><Check size={11} aria-hidden="true" />Main input</span>}</div>
        <div className={styles.columnList} aria-label={`${source.name} columns`}>{sourceColumnNames(source.columns).slice(0, 12).map((column, index) => <span key={index}>{column}</span>)}{source.columns.length > 12 && <span>+{source.columns.length - 12} more</span>}</div>
        {used.length > 0 && <p className={styles.usedBy}>Used by {used.join(", ")}</p>}
        <div className={styles.cardActions}><Button variant="outline" size="sm" aria-expanded={preview === source.id} onClick={() => setPreview((current) => current === source.id ? "" : source.id)}>{preview === source.id ? "Hide preview" : "Preview 20 rows"}</Button>{!main && <Button size="sm" variant="ghost" disabled={!pipeline || !!busy} onClick={() => { void makeMain(source); }} aria-label={`Use as main input: ${source.name}`}>Use as main input</Button>}<span className={styles.actionSpacer} /><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => { setRenaming(source.id); setName(source.name); }} aria-label={`Rename ${source.name}`}><Pencil size={12} aria-hidden="true" />Rename</Button><Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setUploading(source)} aria-label={`Replace file: ${source.name}`}><RefreshCw size={12} aria-hidden="true" />Replace file</Button><Button variant="ghost" size="icon" disabled={!!busy || protectedSource} title={main ? "Choose a different main input before removing this source." : used.length ? "Remove the referencing steps before removing this source." : "Remove source"} onClick={() => { void remove(source); }} aria-label={`Remove ${source.name}`}><Trash2 size={13} aria-hidden="true" /></Button></div>
        {protectedSource && <p className={styles.protection}>{main ? "The main input cannot be removed. Choose another main input first." : "Remove this source's references in Prepare before deleting it."}</p>}
        {preview === source.id && <SourcePreview key={`${source.id}:${attempt}`} endpoint={`${endpoint}/${encodeURIComponent(source.id)}/preview?limit=20`} name={source.name} />}
      </article>;
    })}</div>}
    {sources.length > 0 && <Link className={styles.prepareLink} href={`/projects/${encodeURIComponent(projectId)}/prepare`}>Prepare your dataset<ArrowRight size={13} aria-hidden="true" /></Link>}
    {uploading && <SourceUpload endpoint={endpoint} source={uploading === "new" ? undefined : uploading} onClose={() => setUploading(null)} onSaved={changed} />}
  </section>;
}

export function SourcePreview({ endpoint, name }: { endpoint: string; name: string }) {
  const [result, setResult] = useState<{ columns: (SourceColumn | string)[]; rows: Record<string, unknown>[]; warnings?: string[] } | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { const controller = new AbortController(); sourceJson<NonNullable<typeof result>>(endpoint, { signal: controller.signal }).then((body) => { if (!controller.signal.aborted) setResult(body); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }); return () => controller.abort(); }, [endpoint, attempt]);
  if (error) return <div className={styles.error} role="alert">{error}<Button size="sm" variant="outline" onClick={() => { setError(""); setAttempt((value) => value + 1); }}>Retry preview</Button></div>;
  if (!result) return <p className={styles.loading} role="status">Loading the first 20 rows…</p>;
  const columns = sourceColumnNames(result.columns);
  return <div className={styles.preview}><div className={styles.previewHeading}><strong>Source preview</strong><span>First {result.rows.length} rows · values before preparation</span></div>{result.warnings?.map((warning, index) => <p className={styles.warning} key={index}>{warning}</p>)}<div className={styles.tableScroll} role="region" aria-label={`${name} source preview`} tabIndex={0}><table><caption className={styles.srOnly}>{name}, first {result.rows.length} source rows</caption><thead><tr>{columns.map((column, index) => <th scope="col" key={index}>{column}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index}>{columns.map((column, ordinal) => <td key={ordinal} title={row[column] == null ? "Empty" : String(row[column])}>{row[column] === "" || row[column] == null ? "—" : String(row[column])}</td>)}</tr>)}</tbody></table>{!result.rows.length && <p className={styles.noRows}>This source has no data rows.</p>}</div></div>;
}

function SourceUpload({ endpoint, source, onClose, onSaved }: { endpoint: string; source?: SourceRecord; onClose: () => void; onSaved: (body: SourceChange) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(source?.name ?? "");
  const [delimiter, setDelimiter] = useState(source?.options.delimiter === "\t" ? "tab" : source?.options.delimiter ?? "auto");
  const [headerRow, setHeaderRow] = useState(source?.options.headerRow ?? 1);
  const [jsonPath, setJsonPath] = useState(source?.options.jsonArrayPath ?? "");
  const [separator, setSeparator] = useState(source?.options.arraySeparator ?? " | ");
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState(source?.options.sheetName ?? "");
  const [allSheets, setAllSheets] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const kind = file?.name.toLowerCase().split(".").at(-1) ?? source?.kind;
  useEffect(() => { dialog.current?.showModal(); return () => { request.current?.abort(); }; }, []);
  useEffect(() => {
    if (!file || !file.name.toLowerCase().endsWith(".xlsx") || !file.size || file.size > MAX_SOURCE_BYTES) return;
    const controller = new AbortController();
    const body = new FormData(); body.set("file", file);
    sourceJson<{ sheets: string[] }>(`${endpoint}/inspect`, { method: "POST", body, signal: controller.signal }).then((result) => { if (controller.signal.aborted) return; setSheets(result.sheets); setSheet((current) => result.sheets.includes(current) ? current : result.sheets[0] ?? ""); }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); }).finally(() => { if (!controller.signal.aborted) setInspecting(false); });
    return () => controller.abort();
  }, [file, endpoint]);
  const submit = () => {
    if (!file) { setError("Choose a file to upload."); return; }
    if (file.size > MAX_SOURCE_BYTES) { setError("Choose a file no larger than 50 MB."); return; }
    if (!file.size) { setError("The selected file is empty."); return; }
    if (!name.trim()) { setError("Enter a source name."); return; }
    const options: SourceRecord["options"] = { version: 1 };
    if (kind === "csv") { options.headerRow = headerRow; if (delimiter !== "auto") options.delimiter = delimiter === "tab" ? "\t" : delimiter; }
    if (kind === "xlsx") { options.headerRow = headerRow; if (sheet) options.sheetName = sheet; }
    if (kind === "json") { if (jsonPath.trim()) options.jsonArrayPath = jsonPath.trim(); options.arraySeparator = separator; }
    const body = new FormData(); body.set("file", file); body.set("name", name.trim()); body.set("options", JSON.stringify(options));
    if (kind === "xlsx" && allSheets && !source) body.set("sheets", JSON.stringify(sheets));
    setError(""); setUploading(true); setProgress(0);
    const xhr = new XMLHttpRequest(); request.current = xhr;
    xhr.open(source ? "PUT" : "POST", source ? `${endpoint}/${encodeURIComponent(source.id)}` : endpoint);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) setProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => { setUploading(false); if (xhr.status < 200 || xhr.status >= 300) { setError(typeof xhr.response?.error === "string" ? xhr.response.error : "The file could not be imported. Check its format and try again."); return; } setProgress(100); onSaved(xhr.response as SourceChange); };
    xhr.onerror = () => { setUploading(false); setError("The source upload could not reach the app. Try again."); };
    xhr.onabort = () => { setUploading(false); setError("Source upload cancelled."); };
    xhr.send(body);
  };
  return <dialog ref={dialog} className={styles.dialog} onCancel={(event) => { event.preventDefault(); request.current?.abort(); onClose(); }} aria-labelledby="source-upload-title"><form onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>{source ? "UPDATE INPUT" : "ADD INPUT"}</span><h2 id="source-upload-title">{source ? `Replace ${source.name}` : "Add source"}</h2></div><Button type="button" size="icon" variant="ghost" aria-label="Close source upload" onClick={() => { request.current?.abort(); onClose(); }}><X size={15} aria-hidden="true" /></Button></div>
    <p className={styles.help}>{source ? "The source keeps its ID and pipeline steps. If columns change, affected steps will be listed for review." : "CSV, Excel, or JSON · up to 50 MB per file. Files stay inside this project."}</p>
    <label className={styles.field}>File<input autoFocus type="file" accept=".csv,.xlsx,.json" required disabled={uploading} onChange={(event) => { const selected = event.target.files?.[0] ?? null; setError(""); setSheets([]); setAllSheets(false); setFile(selected); setInspecting(!!selected?.name.toLowerCase().endsWith(".xlsx") && selected.size > 0 && selected.size <= MAX_SOURCE_BYTES); if (selected && !source) setName(selected.name.replace(/\.[^.]+$/, "")); if (selected && (selected.size > MAX_SOURCE_BYTES || !selected.size)) setError(selected.size > MAX_SOURCE_BYTES ? "Choose a file no larger than 50 MB." : "The selected file is empty."); }} /></label>
    {!source && <label className={styles.field}>Source name<input value={name} maxLength={120} required disabled={uploading} onChange={(event) => setName(event.target.value)} /></label>}
    {(kind === "csv" || kind === "xlsx") && <label className={styles.field}>Header row<input type="number" min={1} max={1000} value={headerRow} disabled={uploading} onChange={(event) => setHeaderRow(Number(event.target.value))} /></label>}
    {kind === "csv" && <div className={styles.field}><span>Delimiter</span><SourceDialogMenu dialog={dialog} disabled={uploading} label="Source delimiter" value={delimiter} options={[{ value: "auto", label: "Detect automatically" }, { value: ",", label: "Comma" }, { value: ";", label: "Semicolon" }, { value: "tab", label: "Tab" }]} onValueChange={setDelimiter} /></div>}
    {kind === "xlsx" && <div className={styles.field}><span>Worksheet</span>{inspecting ? <p role="status">Reading workbook sheets…</p> : sheets.length ? <><SourceDialogMenu dialog={dialog} disabled={uploading} label="Source worksheet" value={sheet} options={sheets.map((entry) => ({ value: entry, label: entry }))} onValueChange={setSheet} />{!source && sheets.length > 1 && <label className={styles.check}><input type="checkbox" checked={allSheets} onChange={(event) => setAllSheets(event.target.checked)} disabled={uploading} />Add each worksheet as a separate source</label>}</> : <p className={styles.help}>Choose an Excel workbook to list its worksheets.</p>}</div>}
    {kind === "json" && <><label className={styles.field}>JSON array path<input value={jsonPath} maxLength={256} disabled={uploading} placeholder="Leave blank for a root array; e.g. data.orders" onChange={(event) => setJsonPath(event.target.value)} /></label><label className={styles.field}>Scalar-array separator<input value={separator} maxLength={30} disabled={uploading} onChange={(event) => setSeparator(event.target.value)} /></label><p className={styles.help}>Nested objects become dot-named columns. Scalar arrays are joined; arrays of objects are skipped with a warning.</p></>}
    {error && <div className={styles.error} role="alert">{error}</div>}
    {uploading && <div className={styles.uploadProgress}><progress aria-label="Source upload progress" max={100} value={progress} /><span role="status">{progress >= 99 ? "Reading and checking source…" : `Uploading… ${progress}%`}</span></div>}
    <div className={styles.dialogActions}><Button type="button" variant="outline" onClick={() => { request.current?.abort(); onClose(); }}>{uploading ? "Cancel upload" : "Cancel"}</Button><Button type="submit" disabled={!file || uploading || inspecting || (kind === "xlsx" && !sheets.length)}>{uploading && <Loader2 size={13} aria-hidden="true" />}{source ? "Replace file" : "Add source"}</Button></div>
  </form></dialog>;
}
