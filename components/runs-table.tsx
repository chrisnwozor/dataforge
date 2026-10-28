"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Search, RefreshCw } from "lucide-react";
import type { RunRecord } from "@/lib/runner/types";
import { DataTable, EmptyState } from "./shared";
import { SelectMenu } from "./select-menu";
import { Button } from "./ui/button";
import {
  RunPanel,
  RunStatusBadge,
  runDuration,
  runStatusLabel,
  runTime,
} from "./run-panel";
import { number } from "@/lib/utils";

export function RunsTable({
  runs: initialRuns,
  projectId,
}: {
  runs: RunRecord[];
  projectId: string;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/runs`,
          { signal, cache: "no-store" },
        );
        const value = (await response.json()) as {
          runs?: RunRecord[];
          error?: string;
        };
        if (!response.ok || !value.runs)
          throw new Error(value.error || "Run history could not be refreshed.");
        if (!signal?.aborted) {
          setRuns(value.runs);
          setError("");
        }
      } catch (failure) {
        if (!signal?.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Run history could not be refreshed.",
          );
      }
    },
    [projectId],
  );
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState === "visible")
        void reload(controller.signal);
    };
    const interval = setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [reload]);
  const update = useCallback(
    (run: RunRecord) =>
      setRuns((previous) =>
        previous.some((item) => item.id === run.id)
          ? previous.map((item) => (item.id === run.id ? run : item))
          : [run, ...previous],
      ),
    [],
  );
  const visible = runs.filter(
    (run) =>
      run.id.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" || run.status === filter),
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
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <SelectMenu
          label="Filter runs by status"
          value={filter}
          onValueChange={setFilter}
          style={{ fontSize: 11 }}
          options={[
            { value: "all", label: "All statuses" },
            ...(
              ["queued", "running", "succeeded", "failed", "cancelled"] as const
            ).map((status) => ({
              value: status,
              label: runStatusLabel(status),
            })),
          ]}
        />
      </div>
      {error && (
        <div className="run-panel-error" role="alert">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw size={12} />
            Retry
          </Button>
        </div>
      )}
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
            {visible.map((run) => (
              <tr
                key={run.id}
                className="clickable-row"
                onClick={() => setSelected(run.id)}
              >
                <td className="mono">
                  <button
                    className="button button-ghost run-history-id"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelected(run.id);
                    }}
                    aria-label={`View details for ${run.id}`}
                    title={run.id}
                  >
                    {run.id}
                  </button>
                </td>
                <td>
                  <RunStatusBadge status={run.status} />
                </td>
                <td className="muted small">{runTime(run.startedAt)}</td>
                <td className="mono">
                  {runDuration(run.startedAt, run.finishedAt) === "—"
                    ? runStatusLabel(run.status)
                    : runDuration(run.startedAt, run.finishedAt)}
                </td>
                <td className="mono">{number(run.rowsLoaded)}</td>
                <td
                  className="mono"
                  style={{
                    color: run.rowsRejected ? "var(--amber)" : "var(--muted)",
                  }}
                >
                  {number(run.rowsRejected)}
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
          title={runs.length ? "No runs found" : "No runs yet"}
          description={
            runs.length
              ? "Try a different run ID or status."
              : "Start a load from Generate to see its progress and history here."
          }
        />
      )}
      <div className="table-foot">
        <span>{visible.length} runs</span>
        <span>Times shown in America/New_York</span>
      </div>
      {selected && (
        <RunPanel
          key={selected}
          projectId={projectId}
          runId={selected}
          onClose={() => setSelected(null)}
          onRunChange={update}
        />
      )}
    </>
  );
}
