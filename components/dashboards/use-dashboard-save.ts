"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DashboardDocument, SavedDashboard } from "@/lib/dashboards/schema";

type SaveState = { status: "saved" | "saving" | "error"; dirty: boolean; error: string; updatedAt: string };
export class DashboardSaveController {
  private state: SaveState;
  private listeners = new Set<() => void>();
  private saved: string;
  private pending: DashboardDocument | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private disposed = false;
  constructor(private endpoint: string, initial: SavedDashboard) {
    this.saved = JSON.stringify(documentOf(initial));
    this.state = { status: "saved", dirty: false, error: "", updatedAt: initial.updatedAt };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<SaveState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  configure(document: DashboardDocument) {
    this.disposed = false;
    const dirty = JSON.stringify(document) !== this.saved;
    this.pending = dirty || this.active ? document : null;
    if (!dirty && !this.active) { this.update({ dirty: false, status: "saved", error: "" }); return; }
    this.update({ dirty: dirty || this.active, status: this.state.status === "error" ? "error" : "saving" });
    clearTimeout(this.timer);
    if (!this.active && this.state.status !== "error") this.timer = setTimeout(() => void this.flush(), 600);
  }
  retry = () => { this.update({ status: "saving", error: "" }); void this.flush(); };
  private async flush() {
    if (this.active || !this.pending || this.disposed) return;
    this.active = true;
    const document = this.pending;
    this.pending = null;
    this.update({ status: "saving", dirty: true, error: "" });
    try {
      const response = await fetch(this.endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...document, updatedAt: this.state.updatedAt }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The dashboard could not be saved. Retry to keep your edits.");
      this.saved = JSON.stringify(document);
      const dirty = this.pending !== null && JSON.stringify(this.pending) !== this.saved;
      if (!dirty) this.pending = null;
      this.update({ updatedAt: body.updatedAt, dirty, status: dirty ? "saving" : "saved", error: "" });
    } catch (error) {
      this.pending ??= document;
      this.update({ status: "error", dirty: true, error: error instanceof Error ? error.message : "The dashboard could not be saved." });
    } finally {
      this.active = false;
      if (this.pending && this.state.status !== "error" && !this.disposed) this.timer = setTimeout(() => void this.flush(), 100);
    }
  }
  dispose = () => { this.disposed = true; clearTimeout(this.timer); };
}
export function documentOf(saved: SavedDashboard): DashboardDocument {
  return { name: saved.name, description: saved.description, layout: saved.layout, filters: saved.filters, settings: saved.settings };
}
export function useDashboardSave(projectId: string, initial: SavedDashboard, document: DashboardDocument, enabled = true) {
  const controller = useMemo(() => new DashboardSaveController(`/api/projects/${encodeURIComponent(projectId)}/dashboards/${encodeURIComponent(initial.id)}`, initial), [projectId, initial]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if(enabled) controller.configure(document); }, [controller, document, enabled]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { ...state, retry: controller.retry };
}
