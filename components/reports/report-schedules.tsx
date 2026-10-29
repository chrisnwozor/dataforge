"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/select-menu";
import { friendlyCron, nextCronRun } from "@/lib/reports/cron";
import { reportParameterSummary, validateReportParameters } from "@/lib/reports/parameters";
import type { ReportDefinition, ReportParameterValues } from "@/lib/reports/schema";
import type { ReportSchedule } from "@/lib/server/reports";
import { ReportParameters } from "./report-parameters";
import styles from "./report-leaves.module.css";

type Format = "pdf" | "xlsx" | "csv";
type Frequency = "daily" | "weekly" | "monthly" | "custom";
interface Props { projectId: string; reportId: string; definition: ReportDefinition; parameters?: ReportParameterValues; onRunStarted?: (runId: string) => void }
const dateLabel = (date: string | null) => date ? new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function ReportSchedules({ projectId, reportId, definition, parameters = {}, onRunStarted }: Props) {
  const [schedules, setSchedules] = useState<ReportSchedule[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<ReportSchedule | "new" | null>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(reportId)}/schedules`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error || "Schedules could not be loaded.");
      if (!Array.isArray(body.schedules)) throw new Error("Schedules returned an incomplete response.");
      if (!controller.signal.aborted) { setSchedules(body.schedules); setError(""); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Schedules could not be loaded."); });
    return () => controller.abort();
  }, [endpoint, attempt]);
  const action = async (schedule: ReportSchedule, type: "run" | "toggle" | "delete") => {
    if (type === "delete" && !window.confirm("Delete this report schedule? Existing report runs will remain available.")) return;
    setBusy(schedule.id); setError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(schedule.id)}${type === "run" ? "/run" : ""}`, { method: type === "run" ? "POST" : type === "delete" ? "DELETE" : "PUT", ...(type === "toggle" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !schedule.enabled }) } : {}) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "The schedule could not be updated."); }
      if (type === "run") { const body = await response.json(); onRunStarted?.((body.run ?? body).id); }
      setAttempt((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "The schedule could not be updated."); }
    finally { setBusy(""); }
  };
  return <section className={styles.root} aria-label="Report schedules">
    <div className={styles.toolbar}><div><h2>Schedules</h2><p>Automate exports in a chosen timezone. Next-run times below use your browser’s timezone.</p></div><Button size="sm" onClick={() => setEditing("new")}><Plus size={13} aria-hidden="true" />New schedule</Button></div>
    <p className={styles.note}>Scheduling requires one persistent Node process. Missed runs are skipped; overlapping runs for the same report are prevented.</p>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {editing && <ScheduleForm key={typeof editing === "string" ? "new" : editing.id} projectId={projectId} endpoint={endpoint} schedule={typeof editing === "string" ? null : editing} definition={definition} parameters={parameters} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setAttempt((value) => value + 1); }} />}
    {!schedules ? <p className={styles.loading} role="status"><Loader2 size={14} className={styles.spin} aria-hidden="true" />Loading schedules…</p> : !schedules.length ? <div className={styles.empty}><CalendarClock size={25} aria-hidden="true" /><h3>No schedules yet</h3><p>Use current preview parameters to create daily, weekly, monthly, or custom cron exports.</p></div> : <div className={styles.scheduleCards}>{schedules.map((schedule) => <article className={styles.scheduleCard} key={schedule.id}>
      <div className={styles.scheduleHeading}><div><h3><code>{schedule.cron}</code></h3><span className={styles.muted}>{schedule.timezone}</span></div><label className={styles.toggle}><input type="checkbox" checked={schedule.enabled} disabled={busy === schedule.id} onChange={() => void action(schedule, "toggle")} aria-label={`Enable schedule ${schedule.id.slice(0, 8)}`} />{schedule.enabled ? "Enabled" : "Paused"}</label></div>
      <dl className={styles.scheduleDetails}><div><dt>Next run</dt><dd>{schedule.enabled ? dateLabel(schedule.nextRunAt) : "Paused"}</dd></div><div><dt>Last run</dt><dd>{dateLabel(schedule.lastRunAt)}</dd></div><div><dt>Formats</dt><dd>{schedule.formats.map((format) => format.toUpperCase()).join(", ")}</dd></div><div><dt>Parameters</dt><dd>{reportParameterSummary(definition, schedule.params) || "None"}</dd></div></dl>
      <div className={styles.actions}><Button size="sm" variant="outline" disabled={busy === schedule.id} onClick={() => void action(schedule, "run")}><Play size={12} aria-hidden="true" />Run now</Button><Button size="sm" variant="ghost" onClick={() => setEditing(schedule)} aria-label={`Edit schedule ${schedule.id.slice(0, 8)}`}><Pencil size={12} aria-hidden="true" />Edit</Button><Button size="icon" variant="ghost" disabled={busy === schedule.id} onClick={() => void action(schedule, "delete")} aria-label={`Delete schedule ${schedule.id.slice(0, 8)}`}><Trash2 size={13} aria-hidden="true" /></Button></div>
    </article>)}</div>}
  </section>;
}

function ScheduleForm({ projectId, endpoint, schedule, definition, parameters, onCancel, onSaved }: { projectId: string; endpoint: string; schedule: ReportSchedule | null; definition: ReportDefinition; parameters: ReportParameterValues; onCancel: () => void; onSaved: () => void }) {
  const [frequency, setFrequency] = useState<Frequency>(schedule ? "custom" : "daily");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState(1);
  const [customCron, setCustomCron] = useState(schedule?.cron ?? "0 9 * * *");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [formats, setFormats] = useState<Format[]>(schedule?.formats ?? ["pdf"]);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [params, setParams] = useState<ReportParameterValues>(schedule?.params ?? parameters);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewAt] = useState(() => Date.now());
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  let cron = customCron, next = "";
  let valid = true;
  try {
    if (frequency !== "custom") { const [hour, minute] = time.split(":").map(Number); cron = friendlyCron(frequency, hour, minute, day); }
    next = nextCronRun(cron, timezone, previewAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch (error) { next = error instanceof Error ? error.message : "Choose a valid schedule."; valid = false; }
  return <form className={styles.scheduleForm} ref={form} aria-label={schedule ? "Edit report schedule" : "New report schedule"} onSubmit={async (event) => {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      const savedParams = validateReportParameters(definition, params);
      if (!formats.length) throw new Error("Choose at least one export format.");
      const response = await fetch(`${endpoint}${schedule ? `/${encodeURIComponent(schedule.id)}` : ""}`, { method: schedule ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cron, timezone, params: savedParams, formats, enabled }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || "The schedule could not be saved."); }
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : "The schedule could not be saved."); }
    finally { setSaving(false); }
  }}>
    <h3>{schedule ? "Edit schedule" : "New schedule"}</h3>
    <div className={styles.formGrid}><div className={styles.field}><span>Frequency</span><SelectMenu label="Schedule frequency" value={frequency} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom cron" }]} onValueChange={(value) => { setFrequency(value as Frequency); setDay(1); }} /></div>
      {frequency === "custom" ? <label className={styles.field}>Cron expression<input value={customCron} maxLength={120} onChange={(event) => setCustomCron(event.target.value)} placeholder="0 9 * * *" required /></label> : <label className={styles.field}>Time<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label>}
      {frequency === "weekly" && <div className={styles.field}><span>Day of week</span><SelectMenu label="Schedule weekday" value={String(day)} options={weekdays.map((label, index) => ({ label, value: String(index) }))} onValueChange={(value) => setDay(Number(value))} /></div>}
      {frequency === "monthly" && <label className={styles.field}>Day of month<input type="number" min={1} max={31} value={day} onChange={(event) => setDay(Number(event.target.value))} /></label>}
      <label className={styles.field}>Timezone<input value={timezone} maxLength={100} onChange={(event) => setTimezone(event.target.value)} placeholder="America/New_York" required /></label>
    </div>
    <button type="button" className={styles.textButton} onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use my browser timezone</button>
    <p className={styles.note}>Next run: {next}{valid ? " (your timezone)" : ""}{frequency === "monthly" && day > 28 ? ". Months without this day are skipped." : ""}</p>
    <fieldset className={styles.formatFieldset}><legend>Export formats</legend>{(["pdf", "xlsx", "csv"] as const).map((format) => <label key={format}><input type="checkbox" checked={formats.includes(format)} onChange={(event) => setFormats((current) => event.target.checked ? [...current, format] : current.filter((value) => value !== format))} />{format.toUpperCase()}</label>)}</fieldset>
    <h4 className={styles.parametersTitle}>Saved parameter values</h4>
    <ReportParameters projectId={projectId} definition={definition} values={params} model={null} onChange={setParams} />
    <button type="button" className={styles.textButton} onClick={() => setParams(parameters)}>Use current preview parameters</button>
    <label className={styles.toggle}><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable schedule</label>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <div className={styles.actions}><Button type="button" variant="outline" size="sm" disabled={saving} onClick={onCancel}>Cancel schedule edit</Button><Button type="submit" size="sm" disabled={saving || !valid || !formats.length}>{saving && <Loader2 size={12} className={styles.spin} aria-hidden="true" />}{saving ? "Saving…" : "Save schedule"}</Button></div>
  </form>;
}
