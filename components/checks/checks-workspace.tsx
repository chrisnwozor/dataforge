"use client";

import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CircleCheck,
  Clipboard,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkSettingsSchema } from "@/lib/verify/schema";
import type { CheckRun, CheckSettings, CheckStatus } from "@/lib/verify/types";
import { checksJson, type ChecksResponse } from "./api";
import { CheckDetails } from "./check-details";
import {
  CHECK_AREAS,
  CHECK_STATUSES,
  checkReportText,
  checkRunDuration,
  checkRunIsStale,
  checkRunLabel,
  countCheckResults,
  formatCheckNumber,
  isCheckRunActive,
  resultCountsNotice,
  type ChecksTab,
} from "./presentation";
import styles from "./checks.module.css";

const body = (value: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
const statusNames = {
  pass: "Passed",
  warn: "Warnings",
  fail: "Failed",
  skipped: "Skipped",
};
const tabNames: readonly ChecksTab[] = ["Summary", ...CHECK_AREAS];
const dateLabel = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
function updateRun(runs: CheckRun[], run: CheckRun): CheckRun[] {
  return [run, ...runs.filter((previous) => previous.id !== run.id)].sort(
    (a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
  );
}

export function ChecksWorkspace({ projectId }: { projectId: string }) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/checks`;
  const id = useId();
  const [runs, setRuns] = useState<CheckRun[]>([]);
  const [settings, setSettings] = useState<CheckSettings>(() =>
    checkSettingsSchema.parse({}),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CheckRun | null>(null);
  const [snapshot, setSnapshot] = useState<
    Pick<ChecksResponse, "latestSourceRunId" | "modelVersion">
  >({});
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<"start" | "cancel" | "settings" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<ChecksTab>("Summary");
  const [status, setStatus] = useState<"all" | CheckStatus>("all");
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(0);
  const [absolute, setAbsolute] = useState("0.01");
  const [relative, setRelative] = useState("0.000001");
  const [auto, setAuto] = useState(false);
  const selectedMeta =
    runs.find((run) => run.id === selectedId) ?? runs[0] ?? null;
  const current = detail?.id === selectedId ? detail : selectedMeta;
  const fullDetails = !!current && current === detail;
  const activeRun = runs.find((run) => run.id === activeId) ?? null;
  const running = activeId !== null;

  useEffect(() => {
    const controller = new AbortController();
    checksJson<ChecksResponse>(endpoint, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setNow(Date.now());
        setRuns(data.runs);
        setSettings(data.settings);
        setAuto(data.settings.autoAfterLoad);
        setAbsolute(String(data.settings.absoluteTolerance));
        setRelative(String(data.settings.relativeTolerance));
        setActiveId(data.activeRunId);
        setSelectedId((previous) =>
          previous && data.runs.some((run) => run.id === previous)
            ? previous
            : (data.runs[0]?.id ?? null),
        );
        setSnapshot({
          latestSourceRunId: data.latestSourceRunId,
          modelVersion: data.modelVersion,
        });
        setLoaded(true);
        setError("");
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          setLoaded(true);
          setError(
            failure instanceof Error
              ? failure.message
              : "Check history could not be loaded.",
          );
        }
      });
    return () => controller.abort();
  }, [endpoint, refresh]);

  useEffect(() => {
    if (!selectedId || selectedId === activeId) return;
    const controller = new AbortController();
    checksJson<{ run: CheckRun }>(
      `${endpoint}/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal },
    )
      .then(({ run }) => {
        if (!controller.signal.aborted) {
          setDetail(run);
          setNow(Date.now());
          setRuns((previous) => updateRun(previous, run));
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The detailed results could not be loaded.",
          );
      });
    return () => controller.abort();
  }, [endpoint, selectedId, activeId, refresh]);

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { run } = await checksJson<{ run: CheckRun }>(
          `${endpoint}/${encodeURIComponent(activeId)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setNow(Date.now());
        setRuns((previous) => updateRun(previous, run));
        if (selectedId === run.id) setDetail(run);
        if (!isCheckRunActive(run)) {
          setActiveId(null);
          setRefresh((value) => value + 1);
          return;
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(
          failure instanceof Error
            ? failure.message
            : "Live checks could not be refreshed. Your previous results are still available.",
        );
      }
      timer = setTimeout(() => {
        void poll();
      }, 1000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [activeId, endpoint, selectedId]);

  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeId]);

  const start = async () => {
    setBusy("start");
    setError("");
    setNotice("");
    try {
      const { run } = await checksJson<{ run: CheckRun }>(endpoint, body({}));
      setRuns((previous) => updateRun(previous, run));
      setDetail(run);
      setSelectedId(run.id);
      setActiveId(isCheckRunActive(run) ? run.id : null);
      setTab("Summary");
      setStatus("all");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Checks could not be started.",
      );
    } finally {
      setBusy(null);
    }
  };
  const cancel = async () => {
    if (!activeId) return;
    setBusy("cancel");
    setError("");
    try {
      const { run } = await checksJson<{ run: CheckRun }>(
        `${endpoint}/${encodeURIComponent(activeId)}/cancel`,
        body({}),
      );
      setRuns((previous) => updateRun(previous, run));
      if (selectedId === run.id) setDetail(run);
      if (!isCheckRunActive(run)) setActiveId(null);
      setNotice(
        "Cancellation requested. Completed check results are retained.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The check run could not be cancelled.",
      );
    } finally {
      setBusy(null);
    }
  };
  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("settings");
    setError("");
    setNotice("");
    try {
      const checked = checkSettingsSchema.safeParse({
        ...settings,
        autoAfterLoad: auto,
        absoluteTolerance: Number(absolute),
        relativeTolerance: Number(relative),
      });
      if (!checked.success)
        throw new Error(
          checked.error.issues[0]?.message || "Check the tolerance settings.",
        );
      const response = await checksJson<{ settings: CheckSettings }>(
        `${endpoint}/settings`,
        body(checked.data, "PUT"),
      );
      setSettings(response.settings);
      setNotice(
        "Check settings saved. Existing run results keep the tolerance they used.",
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Check settings could not be saved.",
      );
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!detail || detail.id !== selectedId) return;
    try {
      await navigator.clipboard.writeText(checkReportText(detail));
      setNotice("The check report was copied as plain text.");
    } catch {
      setError(
        "The report could not be copied. Download the CSV, or select and copy values from the expanded check details.",
      );
    }
  };
  const changeTab = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabNames.length
        : event.key === "ArrowLeft"
          ? (index + tabNames.length - 1) % tabNames.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabNames.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabNames[next]);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  const searchValue = useDeferredValue(search.trim().toLowerCase());
  const results = useMemo(
    () => (fullDetails && current ? current.results : []),
    [fullDetails, current],
  );
  const visible = useMemo(
    () =>
      results.filter(
        (result) =>
          (tab === "Summary" || result.area === tab) &&
          (status === "all" || result.status === status) &&
          (!searchValue ||
            `${result.name} ${result.explanation} ${result.id}`
              .toLowerCase()
              .includes(searchValue)),
      ),
    [results, tab, status, searchValue],
  );
  const reconciliation =
    fullDetails && current ? resultCountsNotice(current) : null;
  const stale = current
    ? checkRunIsStale(
        current,
        snapshot.latestSourceRunId,
        snapshot.modelVersion,
      )
    : false;
  const elapsed = current
    ? checkRunDuration(current, now || Date.parse(current.startedAt))
    : 0;

  return (
    <section className={styles.root} aria-label="Pipeline data checks">
      <div className={styles.toolbar}>
        <p className={styles.caption}>
          Independent references are read-only. A mismatch stays visible; checks
          never repair data or rewrite generated SQL.
        </p>
        <div className={styles.actions}>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </Button>
          <Button
            disabled={running || busy !== null || !loaded}
            onClick={() => {
              void start();
            }}
          >
            {busy === "start" ? (
              <Loader2
                size={15}
                className={styles.spinner}
                aria-hidden="true"
              />
            ) : (
              <Play size={15} aria-hidden="true" />
            )}
            Run all
          </Button>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <strong>Checks need attention.</strong>
          <p>{error}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry refresh
          </Button>
        </div>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {running && activeRun && (
        <section className={styles.panel} aria-label="Active check progress">
          <div className={styles.progressHeading}>
            <div>
              <h2>
                <Loader2
                  size={18}
                  className={styles.spinner}
                  aria-hidden="true"
                />{" "}
                {checkRunLabel(activeRun)}
              </h2>
              <p>
                {activeRun.currentCheck || "Preparing independent references…"}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                void cancel();
              }}
            >
              <Square size={14} aria-hidden="true" />
              {busy === "cancel" ? "Cancelling…" : "Cancel checks"}
            </Button>
          </div>
          <progress
            className={styles.progress}
            aria-label="Data checks progress"
            max={Math.max(1, activeRun.total)}
            value={activeRun.completed}
          />
          <p className={styles.caption}>
            {String(activeRun.completed)} of {String(activeRun.total)} checks
            complete ·{" "}
            {formatCheckNumber(
              checkRunDuration(
                activeRun,
                now || Date.parse(activeRun.startedAt),
              ) / 1000,
            )}{" "}
            s elapsed. User queries have priority; checks may wait for the
            database.
          </p>
        </section>
      )}
      {!loaded ? (
        <div className={styles.loading} role="status">
          <Loader2 size={20} className={styles.spinner} aria-hidden="true" />
          Loading check history…
        </div>
      ) : !current ? (
        <div className={styles.empty}>
          <ShieldCheck size={34} aria-hidden="true" />
          <h2>Give every number a second opinion</h2>
          <p>
            Run independent checks from the prepared dataset through the
            warehouse, semantic measures, reports and dashboards. No results are
            assumed correct because a load completed.
          </p>
          <Button
            disabled={busy !== null || running}
            onClick={() => {
              void start();
            }}
          >
            <Play size={15} aria-hidden="true" />
            Run all checks
          </Button>
        </div>
      ) : (
        <>
          <section className={styles.panel} aria-label="Check run summary">
            <div className={styles.progressHeading}>
              <div>
                <div className={styles.statusLine}>
                  {current.counts.fail ? (
                    <TriangleAlert size={20} aria-hidden="true" />
                  ) : (
                    <CircleCheck size={20} aria-hidden="true" />
                  )}
                  <h2>{checkRunLabel(current)}</h2>
                </div>
                <p className={styles.caption}>
                  Started{" "}
                  <time dateTime={current.startedAt}>
                    {dateLabel(current.startedAt)}
                  </time>
                  {current.finishedAt ? (
                    <>
                      {" "}
                      · Finished{" "}
                      <time dateTime={current.finishedAt}>
                        {dateLabel(current.finishedAt)}
                      </time>
                    </>
                  ) : null}{" "}
                  · {formatCheckNumber(elapsed / 1000)} s elapsed
                </p>
              </div>
              <div className={styles.actions}>
                <Button
                  variant="outline"
                  disabled={!fullDetails}
                  onClick={() => {
                    void copy();
                  }}
                >
                  <Clipboard size={15} aria-hidden="true" />
                  Copy report
                </Button>
                <a
                  className="button button-outline"
                  href={`${endpoint}/${encodeURIComponent(current.id)}/download`}
                >
                  <Download size={15} aria-hidden="true" />
                  Download CSV
                </a>
              </div>
            </div>
            <dl className={styles.counts}>
              {CHECK_STATUSES.map((key) => (
                <div className={styles.count} key={key}>
                  <dt>{statusNames[key]}</dt>
                  <dd>{String(current.counts[key])}</dd>
                </div>
              ))}
            </dl>
            <p className={styles.caption}>
              Run <span className={styles.mono}>{current.id}</span> ·{" "}
              {current.trigger === "load"
                ? "Automatically started after a load"
                : "Started on demand"}
            </p>
            <p className={styles.caption}>
              Source load:{" "}
              <span className={styles.mono}>
                {current.sourceRunId ?? "No successful load available"}
              </span>
              <br />
              Model version:{" "}
              <span className={styles.mono}>
                {current.modelVersion ?? "Not available"}
              </span>
            </p>
            {current.error && (
              <p className={styles.error} role="alert">
                {current.error}
              </p>
            )}
            {stale && (
              <p className={styles.warning}>
                This run describes an earlier load or model version. Run all
                checks again before relying on it for the current project.
              </p>
            )}
            {reconciliation && (
              <p className={styles.error} role="alert">
                {reconciliation}
              </p>
            )}
            <p className={styles.caption}>
              A completed run can contain failures or skipped checks. Expand
              every discrepancy to see its independent reference and suggested
              next step.
            </p>
          </section>
          <div className={styles.tabs} role="tablist" aria-label="Check areas">
            {tabNames.map((name, index) => (
              <button
                key={name}
                id={`${id}-tab-${index}`}
                className={styles.tab}
                type="button"
                role="tab"
                tabIndex={tab === name ? 0 : -1}
                aria-selected={tab === name}
                aria-controls={`${id}-panel`}
                onClick={() => setTab(name)}
                onKeyDown={(event) => changeTab(event, index)}
              >
                {name}
                {name !== "Summary" && fullDetails && (
                  <small>
                    {String(
                      results.filter((result) => result.area === name).length,
                    )}
                  </small>
                )}
              </button>
            ))}
          </div>
          <section
            id={`${id}-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-tab-${tabNames.indexOf(tab)}`}
            tabIndex={0}
          >
            {tab === "Summary" && (
              <div className={styles.areaGrid}>
                {CHECK_AREAS.map((area) => {
                  const counts = countCheckResults(
                    results.filter((result) => result.area === area),
                  );
                  return (
                    <button
                      type="button"
                      className={styles.area}
                      key={area}
                      onClick={() => setTab(area)}
                    >
                      <strong>{area}</strong>
                      <span>
                        {fullDetails
                          ? `${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail · ${counts.skipped} skipped`
                          : "Loading detailed results…"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {!fullDetails ? (
              <p className={styles.loading} role="status">
                <Loader2
                  size={18}
                  className={styles.spinner}
                  aria-hidden="true"
                />
                Loading detailed check results…
              </p>
            ) : (
              <>
                <div className={styles.filters}>
                  <label className={styles.search}>
                    <Search size={16} aria-hidden="true" />
                    <input
                      aria-label="Search check results"
                      placeholder="Search checks…"
                      maxLength={256}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <div
                    className={styles.statusFilters}
                    role="group"
                    aria-label="Filter check status"
                  >
                    {(["all", ...CHECK_STATUSES] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={status === value}
                        onClick={() => setStatus(value)}
                      >
                        {value === "all" ? "All results" : statusNames[value]}
                      </button>
                    ))}
                  </div>
                </div>
                <p className={styles.caption}>
                  {String(visible.length)} result
                  {visible.length === 1 ? "" : "s"}
                  {tab === "Summary" ? " across all areas" : ` in ${tab}`}
                </p>
                <div className={styles.checks}>
                  {visible.map((result) => (
                    <CheckDetails key={result.id} result={result} />
                  ))}
                </div>
                {visible.length === 0 && (
                  <p className={styles.notice}>
                    {current.completed === 0 && isCheckRunActive(current)
                      ? "Results appear as each check finishes."
                      : "No checks match this area, status and search. Choose All results or clear the search."}
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}
      <details className={styles.settings}>
        <summary>Check settings</summary>
        <form className={styles.settingsForm} onSubmit={saveSettings}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
              disabled={busy !== null || !loaded}
            />
            <span>
              Run checks after every successful load
              <small>
                Checks use the project query queue at low priority and run one
                at a time.
              </small>
            </span>
          </label>
          <div className={styles.settingsFields}>
            <label className={styles.field}>
              Absolute tolerance
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                value={absolute}
                required
                onChange={(event) => setAbsolute(event.target.value)}
                disabled={busy !== null || !loaded}
              />
              <span className={styles.caption}>
                Absolute tolerance floor; the check also considers relative
                tolerance.
              </span>
            </label>
            <label className={styles.field}>
              Relative tolerance
              <input
                type="number"
                min="0"
                max="0.01"
                step="any"
                value={relative}
                required
                onChange={(event) => setRelative(event.target.value)}
                disabled={busy !== null || !loaded}
              />
              <span className={styles.caption}>
                Allows small floating-point differences relative to the
                reference value.
              </span>
            </label>
          </div>
          <div>
            <Button variant="outline" disabled={busy !== null || !loaded}>
              {busy === "settings" ? "Saving…" : "Save check settings"}
            </Button>
          </div>
        </form>
      </details>
      {runs.length > 0 && (
        <details className={styles.history}>
          <summary>Run history ({String(runs.length)})</summary>
          <ol>
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className={styles.historyButton}
                  aria-current={run.id === selectedId}
                  onClick={() => {
                    setSelectedId(run.id);
                    setTab("Summary");
                    setStatus("all");
                    setSearch("");
                  }}
                >
                  <span>
                    <strong>{checkRunLabel(run)}</strong>
                    <small>
                      <time dateTime={run.startedAt}>
                        {dateLabel(run.startedAt)}
                      </time>{" "}
                      · {run.trigger === "load" ? "After load" : "Manual"}
                    </small>
                    <small className={styles.mono}>{run.id}</small>
                  </span>
                  <span>
                    {String(run.counts.pass)} pass · {String(run.counts.warn)}{" "}
                    warn · {String(run.counts.fail)} fail ·{" "}
                    {String(run.counts.skipped)} skipped
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
