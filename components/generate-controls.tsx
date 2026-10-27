"use client";

import { useId } from "react";
import { Play, ShieldCheck, Database, Download, Loader2 } from "lucide-react";
import { Button } from "./ui/button";

export function GenerateControls({
  incremental,
  dedupe,
  database,
  databaseError,
  dedupeSaving,
  dedupeUnsaved,
  downloadsDisabled,
  onIncrementalChange,
  onDedupeChange,
  onDatabaseChange,
  cleanedUrl,
}: {
  incremental: boolean;
  dedupe: boolean;
  database: string;
  databaseError: string;
  dedupeSaving: boolean;
  dedupeUnsaved: boolean;
  downloadsDisabled: boolean;
  onIncrementalChange: (value: boolean) => void;
  onDedupeChange: (value: boolean) => void;
  onDatabaseChange: (value: string) => void;
  cleanedUrl: string;
}) {
  const id = useId();
  function downloadCleaned() {
    if (downloadsDisabled) return;
    const anchor = document.createElement("a");
    anchor.href = cleanedUrl;
    anchor.download = "cleaned-source.csv";
    anchor.click();
  }
  return (
    <aside className="generate-controls">
      <section className="panel">
        <div className="panel-header">
          <h2>Load configuration</h2>
          <Database size={14} className="muted" />
        </div>
        <div className="panel-body">
          <div className="detail-row" style={{ paddingTop: 0 }}>
            <span>Target</span>
            <span>SQL Server 2019+</span>
          </div>
          <div className="detail-row">
            <span>Schemas</span>
            <span className="mono">stg · dw · etl</span>
          </div>
          <div className="detail-row">
            <span>Mode</span>
            <span className="mono">
              {incremental ? "Incremental" : "Full refresh"}
            </span>
          </div>
          <label htmlFor={`${id}-database`} className="generate-database-label">
            Target database name
          </label>
          <input
            id={`${id}-database`}
            className="generate-database-input"
            value={database}
            onChange={(event) => onDatabaseChange(event.target.value)}
            maxLength={128}
            aria-invalid={!!databaseError}
            aria-describedby={`${id}-database-help${databaseError ? ` ${id}-database-error` : ""}`}
          />
          <p
            id={`${id}-database-help`}
            className="help-text generate-option-help"
          >
            Used in each script’s USE statement. Create this database before
            running the scripts.
          </p>
          {databaseError && (
            <p
              id={`${id}-database-error`}
              className="inline-error"
              role="alert"
            >
              {databaseError}
            </p>
          )}
          <div className="switch-row generate-option-row">
            <span>Incremental load</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-label="Incremental load"
              aria-checked={incremental}
              onClick={() => onIncrementalChange(!incremental)}
            >
              <span />
            </button>
          </div>
          <p className="help-text generate-option-help">
            Load dates newer than the fact’s latest date. Without a date column,
            the scripts use a full refresh.
          </p>
          <div className="switch-row generate-option-row">
            <span>Remove exact duplicates</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-label="Remove exact duplicates"
              aria-checked={dedupe}
              aria-describedby={`${id}-dedupe-help`}
              onClick={() => onDedupeChange(!dedupe)}
            >
              <span />
            </button>
          </div>
          <p
            id={`${id}-dedupe-help`}
            className="help-text generate-option-help"
          >
            Keep one copy of each identical source row. This choice is shared
            with your saved model.
          </p>
          <span className="generate-dedupe-status small muted" role="status">
            {dedupeSaving ? (
              <>
                <Loader2 size={11} className="animate-spin" /> Saving duplicate
                preference…
              </>
            ) : dedupeUnsaved ? (
              "Duplicate preference not saved"
            ) : (
              "Duplicate preference saved"
            )}
          </span>
          <Button
            variant="outline"
            className="full-width"
            disabled={downloadsDisabled}
            onClick={downloadCleaned}
          >
            <Download size={13} /> Cleaned CSV
          </Button>
          <p className="help-text generate-option-help">
            UTF-8 CSV with consistent line endings, ready for the staging
            script.
          </p>
          <span
            className="generate-run-disabled"
            title="Execution arrives in the next phase"
          >
            <Button
              className="full-width"
              disabled
              title="Execution arrives in the next phase"
              aria-describedby={`${id}-execution-help`}
            >
              <Play size={13} /> Run load
            </Button>
          </span>
          <span id={`${id}-execution-help`} className="sr-only">
            Execution arrives in the next phase
          </span>
        </div>
      </section>
      <div className="model-hint" style={{ marginTop: 14 }}>
        <ShieldCheck size={14} style={{ marginBottom: 8 }} />
        <p>Review before you run.</p>
        <p style={{ marginTop: 5 }}>
          Download and review these scripts, then run them in SSMS or Azure Data
          Studio. DataForge does not execute SQL in this phase.
        </p>
      </div>
    </aside>
  );
}
