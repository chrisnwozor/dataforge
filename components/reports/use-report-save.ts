"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { reportDocumentSchema, type ReportDocument, type SavedReport } from "@/lib/reports/schema";
import { reportBody, reportJson } from "./api";

export interface ReportSaveState { status: "saved" | "saving" | "error"; error?: string }
const SAVED: ReportSaveState = { status: "saved" };
export class ReportSaveController {
  private revision: string;
  private saved: string;
  private pending: ReportDocument | null = null;
  private active: Promise<boolean> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private snapshot: ReportSaveState = SAVED;
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private endpoint: string, initial: SavedReport, private save = (url: string, body: unknown) => reportJson<SavedReport>(url, reportBody(body, "PUT"))) { this.revision = initial.updatedAt; this.saved = JSON.stringify({ name: initial.name, description: initial.description, definition: initial.definition }); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => SAVED;
  private publish(snapshot: ReportSaveState) { this.snapshot = snapshot; if (!this.disposed) this.listeners.forEach((listener) => listener()); }
  update(document: ReportDocument) {
    this.disposed = false; clearTimeout(this.timer);
    // Retain an undo to the old saved value while an intermediate PUT is active.
    this.pending = structuredClone(document);
    if (!this.active && JSON.stringify(document) === this.saved) { this.pending = null; this.publish(SAVED); return; }
    this.publish({ status: "saving" });
    if (!this.active) this.timer = setTimeout(() => { void this.flush(); }, 650);
  }
  isDirty = () => !!this.pending || !!this.active;
  flush = async (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.active) { const success = await this.active; return success && (!this.pending || this.flush()); }
    const document = this.pending;
    if (!document || JSON.stringify(document) === this.saved) { this.pending = null; this.publish(SAVED); return true; }
    const parsed = reportDocumentSchema.safeParse(document);
    if (!parsed.success) { this.publish({ status: "error", error: parsed.error.issues[0]?.message ?? "Complete the report properties before saving." }); return false; }
    this.pending = null; this.publish({ status: "saving" });
    const operation = (async () => {
      try { const saved = await this.save(this.endpoint, { ...parsed.data, updatedAt: this.revision }); this.revision = saved.updatedAt; this.saved = JSON.stringify(parsed.data); return true; }
      catch (reason) { this.pending ??= document; this.publish({ status: "error", error: reason instanceof Error ? reason.message : "The report could not be saved." }); return false; }
    })();
    this.active = operation;
    const success = await operation; this.active = null;
    if (!success) return false;
    if (this.pending && !this.disposed) return this.flush();
    this.publish(SAVED); return true;
  };
  dispose = () => { this.disposed = true; clearTimeout(this.timer); };
}

export function useReportSave(endpoint: string, initial: SavedReport, document: ReportDocument) {
  const controller = useMemo(() => new ReportSaveController(endpoint, initial), [endpoint, initial]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => { controller.update(document); }, [controller, document]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { ...state, flush: controller.flush, isDirty: controller.isDirty };
}
