"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Info,
  Loader2,
  Play,
  RefreshCw,
} from "lucide-react";
import type { GenerationResponse } from "@/lib/server/generation";
import type { Model } from "@/lib/modeling/types";
import type { PublicConnection } from "@/lib/server/connection";
import { isTerminalRun, type RunRecord } from "@/lib/runner/types";
import { CodeViewer } from "./code-viewer";
import { GenerateControls } from "./generate-controls";
import { Button } from "./ui/button";
import { RunPanel } from "./run-panel";

function databaseError(value: string): string {
  if (!value.trim()) return "Enter a target database name.";
  if (value.trim().length > 128) return "Use 128 characters or fewer.";
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value))
    return "Database names cannot contain control characters or line breaks.";
  return "";
}

export function GenerationWorkspace({
  projectId,
  initialGeneration,
  initialConnection,
  initialActiveRun,
}: {
  projectId: string;
  initialGeneration: GenerationResponse;
  initialConnection: PublicConnection;
  initialActiveRun: RunRecord | null;
}) {
  const [generation, setGeneration] = useState(initialGeneration);
  const [incremental, setIncremental] = useState(
    initialGeneration.options.incremental,
  );
  const [database, setDatabase] = useState(initialGeneration.options.database);
  const [dedupe, setDedupe] = useState(initialGeneration.savedDedupe);
  const [loading, setLoading] = useState(false);
  const [dedupeSaving, setDedupeSaving] = useState(false);
  const [dedupeUnsaved, setDedupeUnsaved] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState(initialConnection);
  const [activeRun, setActiveRun] = useState(initialActiveRun);
  const [selectedRun, setSelectedRun] = useState<string | null>(
    initialActiveRun?.id ?? null,
  );
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [confirmationTarget, setConfirmationTarget] =
    useState<PublicConnection | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [runError, setRunError] = useState("");
  const runDialog = useRef<HTMLDialogElement>(null);
  const runRequest = useRef(false);
  const completedRuns = useRef(new Set<string>());
  const optionsRef = useRef({ incremental, database });
  const generationRef = useRef(initialGeneration);
  const pendingPreference = useRef<boolean | null>(null);
  const preferencePromise = useRef<Promise<void> | null>(null);
  const preferenceSaving = useRef(false);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const firstOptions = useRef(true);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/generate`;
  const modelEndpoint = `/api/projects/${encodeURIComponent(projectId)}/model`;
  const invalidDatabase = databaseError(database);

  const loadGeneration = useCallback(async () => {
    if (!mounted.current || preferenceSaving.current) return;
    if (pendingPreference.current !== null) {
      setLoading(false);
      return;
    }
    const options = optionsRef.current;
    if (databaseError(options.database)) {
      setLoading(false);
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const version = ++requestVersion.current;
    setLoading(true);
    const query = new URLSearchParams({
      incremental: String(options.incremental),
      db: options.database.trim(),
    });
    try {
      const response = await fetch(`${endpoint}?${query}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const result = (await response.json()) as GenerationResponse & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          result.error || "The scripts could not be generated. Try again.",
        );
      if (!mounted.current || version !== requestVersion.current) return;
      generationRef.current = result;
      setGeneration(result);
      if (pendingPreference.current === null && !preferenceSaving.current)
        setDedupe(result.savedDedupe);
      setError("");
    } catch (failure) {
      if (
        controller.signal.aborted ||
        !mounted.current ||
        version !== requestVersion.current
      )
        return;
      setError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Try again.",
      );
    } finally {
      if (mounted.current && version === requestVersion.current) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [endpoint]);

  function invalidateGeneration() {
    request.current?.abort();
    request.current = null;
    requestVersion.current++;
    if (pendingPreference.current === null) setError("");
    setLoading(pendingPreference.current === null || preferenceSaving.current);
  }
  function changeIncremental(value: boolean) {
    optionsRef.current.incremental = value;
    setIncremental(value);
    invalidateGeneration();
  }
  function changeDatabase(value: string) {
    optionsRef.current.database = value;
    setDatabase(value);
    invalidateGeneration();
    if (databaseError(value)) setLoading(false);
  }

  const savePreference = useCallback(
    async (value: boolean) => {
      pendingPreference.current = value;
      setDedupe(value);
      setDedupeSaving(true);
      setDedupeUnsaved(true);
      setLoading(true);
      setError("");
      request.current?.abort();
      request.current = null;
      requestVersion.current++;
      if (preferencePromise.current) return preferencePromise.current;
      preferenceSaving.current = true;
      const saving = (async () => {
        while (pendingPreference.current !== null) {
          const next = pendingPreference.current;
          pendingPreference.current = null;
          try {
            // Read the latest model before changing its shared preference.
            const currentResponse = await fetch(modelEndpoint, {
              cache: "no-store",
            });
            const current = (await currentResponse.json()) as {
              model?: Model;
              error?: string;
            };
            if (!currentResponse.ok || !current.model)
              throw new Error(
                current.error || "The saved model could not be read.",
              );
            const body = JSON.stringify({
              model: { ...current.model, removeExactDuplicates: next },
            });
            const response = await fetch(modelEndpoint, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body,
              keepalive: new TextEncoder().encode(body).byteLength <= 60_000,
            });
            if (!response.ok) {
              const result = (await response.json().catch(() => null)) as {
                error?: string;
              } | null;
              throw new Error(
                result?.error ||
                  "The duplicate preference could not be saved. Try again.",
              );
            }
          } catch (failure) {
            pendingPreference.current ??= next;
            if (mounted.current) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "The preference could not be saved. Try again.",
              );
              setLoading(false);
            }
            return;
          }
        }
      })();
      preferencePromise.current = saving;
      try {
        await saving;
      } finally {
        preferencePromise.current = null;
        preferenceSaving.current = false;
        if (mounted.current) {
          setDedupeSaving(false);
          setDedupeUnsaved(pendingPreference.current !== null);
          if (pendingPreference.current === null) await loadGeneration();
        }
      }
    },
    [modelEndpoint, loadGeneration],
  );

  useEffect(() => {
    if (firstOptions.current) {
      firstOptions.current = false;
      return;
    }
    if (databaseError(database)) return;
    const timer = setTimeout(() => void loadGeneration(), 400);
    return () => clearTimeout(timer);
  }, [incremental, database, loadGeneration]);

  useEffect(() => {
    mounted.current = true;
    let checking = false;
    const controller = new AbortController();
    async function checkModel() {
      if (
        document.visibilityState !== "visible" ||
        checking ||
        request.current ||
        preferenceSaving.current ||
        pendingPreference.current !== null ||
        databaseError(optionsRef.current.database)
      )
        return;
      checking = true;
      try {
        const response = await fetch(modelEndpoint, {
          signal: controller.signal,
          cache: "no-store",
        });
        const result = (await response.json()) as {
          updatedAt?: string;
          error?: string;
        };
        if (!response.ok)
          throw new Error(
            result.error || "The saved model could not be checked. Try again.",
          );
        if (
          mounted.current &&
          result.updatedAt !== generationRef.current.modelUpdatedAt
        )
          await loadGeneration();
      } catch (failure) {
        if (!controller.signal.aborted && mounted.current)
          setError(
            failure instanceof Error
              ? failure.message
              : "The saved model could not be checked. Try again.",
          );
      } finally {
        checking = false;
      }
    }
    const interval = setInterval(() => void checkModel(), 3000);
    const refresh = () => void checkModel();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      controller.abort();
      request.current?.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [modelEndpoint, loadGeneration]);

  useEffect(() => {
    const controller = new AbortController();
    let refreshing = false;
    async function refreshExecution() {
      if (refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        const [settings, history] = await Promise.all([
          fetch(`/api/projects/${projectId}/execution-target`, {
            cache: "no-store",
            signal: controller.signal,
          }),
          fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
            cache: "no-store",
            signal: controller.signal,
          }),
        ]);
        if (settings.ok) {
          const value = (await settings.json()) as {
            connection: PublicConnection;
          };
          if (!controller.signal.aborted) setConnection(value.connection);
        }
        if (history.ok) {
          const value = (await history.json()) as { runs: RunRecord[] };
          if (!controller.signal.aborted)
            setActiveRun(
              value.runs.find(
                (run) =>
                  !isTerminalRun(run.status) &&
                  !completedRuns.current.has(run.id),
              ) ?? null,
            );
        }
      } catch {
        // A failed status refresh never enables an unsafe Run action.
      } finally {
        refreshing = false;
      }
    }
    const interval = setInterval(() => void refreshExecution(), 3000);
    const focus = () => void refreshExecution();
    window.addEventListener("focus", focus);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [projectId]);

  useEffect(() => {
    if (confirmingRun && runDialog.current && !runDialog.current.open)
      runDialog.current.showModal();
    else if (!confirmingRun) runDialog.current?.close();
  }, [confirmingRun]);

  const modelErrors = generation.validation.filter(
    (issue) => issue.severity === "error",
  );
  const modelWarnings = generation.validation.filter(
    (issue) => issue.severity === "warning",
  );
  const modelInfo = generation.validation.filter(
    (issue) => issue.severity === "info",
  );
  const staleOptions =
    generation.options.incremental !== incremental ||
    generation.options.database !== database.trim() ||
    generation.savedDedupe !== dedupe;
  const downloadsDisabled =
    loading ||
    dedupeSaving ||
    !!error ||
    !!invalidDatabase ||
    staleOptions ||
    modelErrors.length > 0 ||
    !generation.files.length;
  const query = new URLSearchParams({
    incremental: String(incremental),
    dedupe: String(dedupe),
    db: database.trim(),
  });
  const connectionMismatch = connection.database !== database.trim();
  const runDisabledReason = !connection.configured
    ? connection.configurationError ||
      "Configure a SQL Server connection in Settings before running a load."
    : connectionMismatch
      ? "The target database must match the saved connection in Settings."
      : activeRun
        ? "A run is already active for this project."
        : modelErrors.length
          ? "Resolve the model errors before running a load."
          : downloadsDisabled
            ? "Wait for the current options and model to finish saving and generating."
            : startingRun
              ? "A run is being started."
              : "";
  const effectiveIncremental =
    incremental &&
    !generation.validation.some(
      (issue) => issue.code === "incremental-without-date",
    );
  const confirmationStale =
    confirmationTarget?.updatedAt !== connection.updatedAt;
  const updateRun = useCallback((run: RunRecord) => {
    if (isTerminalRun(run.status)) completedRuns.current.add(run.id);
    setActiveRun((previous) =>
      isTerminalRun(run.status)
        ? previous?.id === run.id
          ? null
          : previous
        : run,
    );
  }, []);

  async function startRun() {
    if (
      runRequest.current ||
      runDisabledReason ||
      !confirmationTarget ||
      confirmationStale
    )
      return;
    runRequest.current = true;
    setStartingRun(true);
    setRunError("");
    try {
      const settingsResponse = await fetch(`/api/projects/${projectId}/execution-target`, {
        cache: "no-store",
      });
      const latest = (await settingsResponse.json()) as {
        connection?: PublicConnection;
        error?: string;
      };
      if (!settingsResponse.ok || !latest.connection)
        throw new Error(
          latest.error || "The saved connection could not be checked.",
        );
      if (
        !latest.connection.configured ||
        latest.connection.updatedAt !== confirmationTarget.updatedAt
      ) {
        setConnection(latest.connection);
        throw new Error(
          "Connection settings changed. Review the target and confirm the load again.",
        );
      }
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            incremental,
            dedupe,
            db: database.trim(),
            connectionUpdatedAt: confirmationTarget.updatedAt,
          }),
        },
      );
      const value = (await response.json()) as {
        runId?: string;
        run?: RunRecord;
        activeRunId?: string;
        error?: string;
      };
      if (response.status === 409 && value.activeRunId) {
        setSelectedRun(value.activeRunId);
        setConfirmingRun(false);
        return;
      }
      if (!response.ok || !value.runId)
        throw new Error(
          value.error || "The load could not be started. Try again.",
        );
      if (value.run) setActiveRun(value.run);
      setSelectedRun(value.runId);
      setConfirmingRun(false);
    } catch (failure) {
      setRunError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Try again.",
      );
    } finally {
      runRequest.current = false;
      setStartingRun(false);
    }
  }

  return (
    <>
      <div className="generate-status-row" role="status" aria-live="polite">
        {loading || dedupeSaving ? (
          <>
            <Loader2 size={12} className="animate-spin" /> Updating scripts…
          </>
        ) : error || invalidDatabase || modelErrors.length ? (
          <>
            <AlertTriangle size={12} />{" "}
            {modelErrors.length
              ? "Resolve model errors to generate scripts."
              : invalidDatabase
                ? "Enter a valid target database name."
                : "Scripts need attention."}
          </>
        ) : (
          <>
            <Check size={12} /> Scripts reflect your saved model.
          </>
        )}
      </div>
      {(modelErrors.length > 0 ||
        modelWarnings.length > 0 ||
        modelInfo.length > 0) && (
        <div
          className="info-banner generate-validation-banner"
          role={modelErrors.length ? "alert" : "status"}
        >
          {modelErrors.length || modelWarnings.length ? (
            <AlertTriangle size={16} />
          ) : (
            <Info size={16} />
          )}
          <div>
            <strong>
              {modelErrors.length
                ? "Resolve model errors before downloading."
                : modelWarnings.length
                  ? "Review your model warnings."
                  : "Load notes"}
            </strong>
            <ul>
              {generation.validation.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
          <Link href={`/projects/${projectId}/model`}>Review model</Link>
        </div>
      )}
      {error && (
        <div className="generate-request-error" role="alert">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              pendingPreference.current === null
                ? void loadGeneration()
                : void savePreference(pendingPreference.current)
            }
          >
            <RefreshCw size={12} /> Retry
          </Button>
        </div>
      )}
      <div className="code-layout">
        <CodeViewer
          files={generation.files}
          downloadsDisabled={downloadsDisabled}
          loading={loading || dedupeSaving}
          zipUrl={`${endpoint}/zip?${query}`}
        />
        <GenerateControls
          incremental={incremental}
          dedupe={dedupe}
          database={database}
          databaseError={invalidDatabase}
          dedupeSaving={dedupeSaving}
          dedupeUnsaved={dedupeUnsaved}
          downloadsDisabled={downloadsDisabled}
          onIncrementalChange={changeIncremental}
          onDedupeChange={(value) => void savePreference(value)}
          onDatabaseChange={changeDatabase}
          cleanedUrl={`/api/projects/${encodeURIComponent(projectId)}/source/cleaned`}
          runDisabledReason={runDisabledReason}
          startingRun={startingRun}
          connectionConfigured={connection.configured}
          connectionServer={connection.server}
          activeRun={activeRun}
          onRun={() => {
            setRunError("");
            setConfirmationTarget(connection);
            setConfirmingRun(true);
          }}
          onOpenActiveRun={() => {
            if (activeRun) setSelectedRun(activeRun.id);
          }}
        />
      </div>
      <dialog
        ref={runDialog}
        className="run-confirm-dialog"
        aria-labelledby="run-confirm-title"
        onCancel={(event) => {
          if (startingRun) event.preventDefault();
          else setConfirmingRun(false);
        }}
      >
        <h2 id="run-confirm-title">Run this load?</h2>
        <div className="detail-row">
          <span>Server</span>
          <strong className="mono">
            {confirmationTarget?.server}:{confirmationTarget?.port}
          </strong>
        </div>
        <div className="detail-row">
          <span>Database</span>
          <strong className="mono">{database.trim()}</strong>
        </div>
        <div className="detail-row">
          <span>Mode</span>
          <strong>
            {effectiveIncremental ? "Incremental" : "Full refresh"}
          </strong>
        </div>
        <p className="run-confirm-notice">
          This will create or modify objects in [{database.trim()}].
        </p>
        {incremental && !effectiveIncremental && (
          <p className="help-text">
            No source date is available; this run uses a full refresh.
          </p>
        )}
        {!effectiveIncremental && (
          <p className="help-text">
            Full refresh replaces the existing fact rows.
          </p>
        )}
        {runError && (
          <p className="inline-error" role="alert">
            {runError}
          </p>
        )}
        {confirmationStale && (
          <p className="inline-error" role="alert">
            Connection settings changed. Keep reviewing, then reopen this
            confirmation to approve the current target.
          </p>
        )}
        <div className="run-confirm-actions">
          <Button
            variant="outline"
            disabled={startingRun}
            onClick={() => setConfirmingRun(false)}
          >
            Keep reviewing
          </Button>
          <Button
            disabled={startingRun || !!runDisabledReason || confirmationStale}
            onClick={() => void startRun()}
          >
            {startingRun ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            {startingRun ? "Starting…" : "Confirm run"}
          </Button>
        </div>
      </dialog>
      {selectedRun && (
        <RunPanel
          key={selectedRun}
          projectId={projectId}
          runId={selectedRun}
          onClose={() => setSelectedRun(null)}
          onRunChange={updateRun}
        />
      )}
    </>
  );
}
