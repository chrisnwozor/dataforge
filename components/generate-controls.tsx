"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { Play, Loader2, ArrowRight, ShieldCheck, Database } from "lucide-react";
import { Button } from "./ui/button";
export function GenerateControls({ projectId }: { projectId: string }) {
  const [incremental, setIncremental] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "complete">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function run() {
    setStatus("running");
    timer.current = setTimeout(() => setStatus("complete"), 1400);
  }
  return (
    <aside>
      <section className="panel">
        <div className="panel-header">
          <h2>Load configuration</h2>
          <Database size={14} className="muted" />
        </div>
        <div className="panel-body">
          <div className="detail-row" style={{ paddingTop: 0 }}>
            <span>Target</span>
            <span>SQL Server 2022</span>
          </div>
          <div className="detail-row">
            <span>Schema</span>
            <span className="mono">warehouse</span>
          </div>
          <div className="detail-row">
            <span>Mode</span>
            <span className="mono">
              {incremental ? "Incremental" : "Full refresh"}
            </span>
          </div>
          <div className="switch-row" style={{ marginTop: 22 }}>
            <span>Incremental load</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-label="Incremental load"
              aria-checked={incremental}
              onClick={() => setIncremental(!incremental)}
            >
              <span />
            </button>
          </div>
          <p
            className="help-text"
            style={{ fontSize: 10, margin: "9px 0 22px" }}
          >
            Only load new or changed rows. This demo simulates your selected
            mode; the SQL preview stays unchanged.
          </p>
          <Button
            className="full-width"
            disabled={status === "running"}
            onClick={run}
          >
            {status === "running" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}{" "}
            {status === "running"
              ? "Simulating load…"
              : status === "complete"
                ? "Run again"
                : "Run load"}
          </Button>
          <div role="status">
            {status === "complete" && (
              <p className="run-notice">
                Simulated {incremental ? "incremental" : "full"} load complete.
                9,994 sample rows processed. No database was contacted.
              </p>
            )}
          </div>
          {status === "complete" && (
            <Link
              href={`/projects/${projectId}/runs`}
              className="button button-ghost full-width"
              style={{ marginTop: 8 }}
            >
              View sample run history
              <ArrowRight size={12} />
            </Link>
          )}
        </div>
      </section>
      <div className="model-hint" style={{ marginTop: 14 }}>
        <ShieldCheck size={14} style={{ marginBottom: 8 }} />
        <p>Review before you run.</p>
        <p style={{ marginTop: 5 }}>
          These are static sample scripts, independent of edits in the model
          preview. Nothing is executed against a database.
        </p>
      </div>
    </aside>
  );
}
