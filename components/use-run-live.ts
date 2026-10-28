"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isTerminalRun,
  type RunDetail,
  type RunRecord,
} from "@/lib/runner/types";

/** Polling also covers reverse proxies that buffer otherwise healthy SSE streams. */
export function useRunLive(
  projectId: string,
  runId: string,
  onRunChange?: (run: RunRecord) => void,
) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const callback = useRef(onRunChange);
  const reload = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    callback.current = onRunChange;
  }, [onRunChange]);
  useEffect(() => {
    let disposed = false,
      terminal = false,
      fetching = false,
      lastEvent = 0;
    let lastLogId = -1,
      lastPhase = -1,
      lastStepProgress = -1;
    let events: EventSource | null = null;
    const controller = new AbortController();
    const endpoint = `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;
    function receive(value: RunDetail) {
      if (disposed || value.run?.id !== runId) return;
      const incomingTerminal = isTerminalRun(value.run.status);
      const logId = value.logs.reduce(
        (maximum, line) => Math.max(maximum, line.id),
        -1,
      );
      const phase = incomingTerminal
        ? 2
        : value.run.status === "running"
          ? 1
          : 0;
      const progress = value.steps.reduce(
        (sum, step) =>
          sum +
          (step.status === "queued" ? 0 : step.status === "running" ? 1 : 2),
        0,
      );
      if (
        (terminal && !incomingTerminal) ||
        logId < lastLogId ||
        phase < lastPhase ||
        (logId === lastLogId && progress < lastStepProgress)
      )
        return;
      lastLogId = logId;
      lastPhase = phase;
      lastStepProgress = progress;
      setDetail(value);
      setError("");
      callback.current?.(value.run);
      terminal = incomingTerminal;
      if (terminal) {
        events?.close();
        setStreaming(false);
      }
    }
    async function refresh() {
      if (disposed || fetching || terminal) return;
      fetching = true;
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        const value = (await response.json()) as RunDetail & { error?: string };
        if (!response.ok)
          throw new Error(
            value.error || "Run details could not be loaded. Try again.",
          );
        receive(value);
      } catch (failure) {
        if (!disposed && !controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "The server could not be reached. Try again.",
          );
      } finally {
        fetching = false;
      }
    }
    reload.current = refresh;
    void refresh();
    if (typeof EventSource !== "undefined") {
      events = new EventSource(`${endpoint}/events`);
      const update = (event: MessageEvent<string>) => {
        try {
          lastEvent = Date.now();
          receive(JSON.parse(event.data) as RunDetail);
        } catch {
          void refresh();
        }
      };
      events.addEventListener("snapshot", update as EventListener);
      events.addEventListener("run", update as EventListener);
      events.onopen = () => {
        if (!disposed && !terminal) setStreaming(true);
      };
      events.onerror = () => {
        events?.close();
        if (!disposed) setStreaming(false);
        void refresh();
      };
    }
    const poll = setInterval(() => {
      if (!terminal && Date.now() - lastEvent > 2500) void refresh();
    }, 3000);
    return () => {
      disposed = true;
      controller.abort();
      events?.close();
      clearInterval(poll);
    };
  }, [projectId, runId]);
  const refresh = useCallback(() => reload.current(), []);
  return { detail, error, streaming, refresh };
}
