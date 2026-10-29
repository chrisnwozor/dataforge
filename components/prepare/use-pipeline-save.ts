"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { pipelineDefinitionSchema, type PipelineDefinition } from "@/lib/prepare/schema";
import type { PipelineSummary } from "@/lib/prepare/types";

export interface SavedPipeline { projectId: string; version: number; definition: PipelineDefinition; updatedAt: string; status: "idle" | "queued" | "running" | "succeeded" | "failed" | "cancelled"; progress: PipelineSummary | null; error: string | null; profiledVersion: number | null; qualityRunId?: string }
export async function prepareJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init); const body = await response.json();
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "The preparation request could not be completed.");
  return body as T;
}
export const prepareBody = (value: unknown, method = "POST"): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
const SAVED = { status: "saved" as const };
export class PipelineSaveController {
  private version: number; private saved: string; private pending: PipelineDefinition | null = null; private active: Promise<boolean> | null = null; private timer?: ReturnType<typeof setTimeout>; private disposed = false;
  private state: { status: "saved" | "saving" | "error"; error?: string } = SAVED; private listeners = new Set<() => void>();
  constructor(private endpoint: string, initial: SavedPipeline, private save = (url: string, body: unknown) => prepareJson<SavedPipeline>(url, prepareBody(body, "PUT"))) { this.version = initial.version; this.saved = JSON.stringify(initial.definition); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = () => this.state; getServerSnapshot = () => SAVED;
  private publish(state: typeof this.state) { this.state = state; if (!this.disposed) this.listeners.forEach((listener) => listener()); }
  update(definition: PipelineDefinition) { this.disposed = false; clearTimeout(this.timer); this.pending = structuredClone(definition); if (!this.active && JSON.stringify(definition) === this.saved) { this.pending = null; this.publish(SAVED); return; } this.publish({ status: "saving" }); if (!this.active) this.timer = setTimeout(() => { void this.flush(); }, 650); }
  isDirty = () => !!this.active || !!this.pending;
  flush = async (): Promise<boolean> => {
    clearTimeout(this.timer); if (this.active) { const ok = await this.active; return ok && (!this.pending || this.flush()); }
    const definition = this.pending; if (!definition || JSON.stringify(definition) === this.saved) { this.pending = null; this.publish(SAVED); return true; }
    const parsed = pipelineDefinitionSchema.safeParse(definition); if (!parsed.success) { this.publish({ status: "error", error: parsed.error.issues[0]?.message ?? "Complete this step's settings before saving." }); return false; }
    this.pending = null; this.publish({ status: "saving" });
    const operation = (async () => { try { const saved = await this.save(this.endpoint, { definition: parsed.data, version: this.version }); this.version = saved.version; this.saved = JSON.stringify(parsed.data); return true; } catch (error) { this.pending ??= definition; this.publish({ status: "error", error: error instanceof Error ? error.message : "The pipeline could not be saved." }); return false; } })();
    this.active = operation; const ok = await operation; this.active = null; if (!ok) return false; if (this.pending && !this.disposed) return this.flush(); this.publish(SAVED); return true;
  };
  dispose = () => { this.disposed = true; clearTimeout(this.timer); };
}
export function usePipelineSave(endpoint: string, initial: SavedPipeline, definition: PipelineDefinition) {
  const controller = useMemo(() => new PipelineSaveController(endpoint, initial), [endpoint, initial]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => { controller.update(definition); }, [controller, definition]); useEffect(() => () => controller.dispose(), [controller]);
  return { ...state, flush: controller.flush, isDirty: controller.isDirty };
}
