"use client";
import { useState, useRef, useEffect } from "react";
import {
  X,
  ArrowUpRight,
  Search,
  Terminal,
  CheckCircle2,
  Info,
} from "lucide-react";
import type { Run } from "@/lib/types";
import { StatusBadge, DataTable, EmptyState } from "./shared";
import { Button } from "./ui/button";
import { number } from "@/lib/utils";
function RunSheet({ run, onClose }: { run: Run; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    dialog.current?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && dialog.current) {
        const elements = Array.from(
          dialog.current.querySelectorAll<HTMLElement>(
            'button,a[href],input,select,[tabindex="0"]',
          ),
        );
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, [onClose]);
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-sheet-title"
        ref={dialog}
        tabIndex={-1}
      >
        <div className="sheet-title">
          <div>
            <div className="eyebrow">RUN DETAILS</div>
            <h2 id="run-sheet-title">{run.id}</h2>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close run details"
          >
            <X size={18} />
          </Button>
        </div>
        <StatusBadge status={run.status} />
        <div style={{ marginTop: 18 }}>
          {[
            ["Started", run.started],
            ["Duration", run.duration],
            ["Rows loaded", number(run.rowsLoaded)],
            ["Rows rejected", number(run.rowsRejected)],
          ].map(([k, v]) => (
            <div className="detail-row" key={k}>
              <span>{k}</span>
              <span className="mono">{v}</span>
            </div>
          ))}
        </div>
        <h3 style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Terminal size={14} />
          Execution logs
        </h3>
        <div
          className="log-viewer"
          tabIndex={0}
          role="region"
          aria-label="Execution logs"
        >
          {run.logs.map((l, i) => (
            <div
              key={i}
              className={`log-line ${l.level === "ERROR" ? "error" : l.level === "SUCCESS" ? "success" : ""}`}
            >
              <span>{l.time}</span>[{l.level}] {l.message}
            </div>
          ))}
        </div>
        <h3>
          Rejected rows{" "}
          {run.rowsRejected > 0 && (
            <span className="count">{run.rowsRejected}</span>
          )}
        </h3>
        {run.rejected.length ? (
          <>
            <DataTable>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Column</th>
                  <th>Value</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {run.rejected.map((r) => (
                  <tr key={r.row}>
                    <td className="mono">{r.row}</td>
                    <td>{r.column}</td>
                    <td className="mono">{r.value || "(empty)"}</td>
                    <td className="muted">{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <p className="form-hint">
              Showing {run.rejected.length} sample rejected rows of{" "}
              {run.rowsRejected}.
            </p>
          </>
        ) : (
          <div className="info-banner" style={{ marginTop: 0 }}>
            <CheckCircle2 size={15} style={{ color: "var(--green)" }} />
            No rejected rows. All rows passed validation.
          </div>
        )}
        <p className="help-text" style={{ marginTop: 25 }}>
          This is a simulated run. No database connection was made.
        </p>
      </div>
    </>
  );
}
export function RunsTable({ runs }: { runs: Run[] }) {
  const [selected, setSelected] = useState<Run | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const visible = runs.filter(
    (r) =>
      r.id.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || r.status === filter),
  );
  return (
    <>
      <div className="toolbar">
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Search runs"
            placeholder="Search by run ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter runs by status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ fontSize: 11 }}
        >
          <option value="all">All statuses</option>
          <option>Success</option>
          <option>Failed</option>
          <option>Running</option>
        </select>
      </div>
      {visible.length ? (
        <DataTable>
          <thead>
            <tr>
              <th>Run ID</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Rows loaded</th>
              <th>Rows rejected</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className="clickable-row"
                onClick={() => setSelected(r)}
              >
                <td className="mono">
                  <button
                    className="button button-ghost"
                    style={{ padding: 0, minHeight: 0, color: "var(--text)" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected(r);
                    }}
                    aria-label={`View details for ${r.id}`}
                  >
                    {r.id}
                  </button>
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="muted small">{r.started}</td>
                <td className="mono">{r.duration}</td>
                <td className="mono">{number(r.rowsLoaded)}</td>
                <td
                  className="mono"
                  style={{
                    color: r.rowsRejected ? "var(--amber)" : "var(--muted)",
                  }}
                >
                  {r.rowsRejected}
                </td>
                <td>
                  <ArrowUpRight size={13} className="muted" />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <EmptyState
          title="No runs found"
          description="Try a different run ID or status."
        />
      )}
      <div className="table-foot">
        <span>{visible.length} runs</span>
        <span>Times shown in America/New_York</span>
      </div>
      <div className="info-banner">
        <Info size={15} />
        <span>
          Click a run to see its execution logs and rejected rows. All runs in
          this workspace are simulated.
        </span>
      </div>
      {selected && (
        <RunSheet run={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
