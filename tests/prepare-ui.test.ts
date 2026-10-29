import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultPipeline, pipelineDefinitionSchema, type PrepareStep } from "@/lib/prepare/schema";
import { createPipelineHistory, pipelineHistoryReducer } from "@/lib/prepare/history";
import { PipelineSaveController, type SavedPipeline } from "@/components/prepare/use-pipeline-save";
import { ConditionBuilder, StepSettings } from "@/components/prepare/step-settings";
import { PreviewGrid } from "@/components/prepare/prepare-editor";
import { makePrepareStep, movePipelineStep, STEP_GROUPS } from "@/components/prepare/state";

const definition = defaultPipeline("orders");
const initial: SavedPipeline = { projectId: "project", version: 1, definition, updatedAt: "2026-01-01T00:00:00.000Z", status: "idle", progress: null, error: null, profiledVersion: null };
const columns = ["Order ID", "Customer ID", "Sales", "Order Date"];
const sources = [{ id: "orders", name: "Orders", kind: "csv", columns }, { id: "customers", name: "Customers", kind: "csv", columns: ["Customer ID", "Customer Name"] }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("preparation autosave", () => {
  it("debounces the latest definition and sends the integer pipeline version", async () => {
    vi.useFakeTimers(); const bodies: unknown[] = [];
    const controller = new PipelineSaveController("/pipeline", initial, async (_url, body) => { bodies.push(body); return { ...initial, version: 2 }; });
    controller.update({ ...definition, steps: [makePrepareStep("cleanText", "clean", columns)] });
    const latest = { ...definition, steps: [makePrepareStep("derive", "derive", columns)] };
    controller.update(latest); await vi.advanceTimersByTimeAsync(649); expect(bodies).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(bodies).toEqual([{ definition: latest, version: 1 }]);
    expect(controller.getSnapshot().status).toBe("saved"); expect(controller.isDirty()).toBe(false); controller.dispose();
  });
  it("saves an undo after an in-flight newer definition finishes, using the returned version", async () => {
    const pending = deferred<SavedPipeline>(), bodies: unknown[] = [];
    const edited = { ...definition, steps: [makePrepareStep("derive", "derive", columns)] };
    const controller = new PipelineSaveController("/pipeline", initial, async (_url, body) => { bodies.push(body); return bodies.length === 1 ? pending.promise : { ...initial, version: 3 }; });
    controller.update(edited); const flushing = controller.flush(); controller.update(definition);
    pending.resolve({ ...initial, version: 2, definition: edited }); await flushing;
    expect(bodies).toEqual([{ definition: edited, version: 1 }, { definition, version: 2 }]);
    expect(controller.isDirty()).toBe(false); controller.dispose();
  });
  it("retains conflicts and the last known revision for explicit retry", async () => {
    const bodies: { version: number }[] = []; let calls = 0;
    const controller = new PipelineSaveController("/pipeline", initial, async (_url, body) => { bodies.push(body as { version: number }); if (++calls === 1) throw new Error("The pipeline changed in another tab."); return { ...initial, version: 2 }; });
    controller.update({ ...definition, steps: [makePrepareStep("sort", "sort", columns)] });
    expect(await controller.flush()).toBe(false); expect(controller.isDirty()).toBe(true); expect(controller.getSnapshot().error).toContain("another tab");
    expect(await controller.flush()).toBe(true); expect(bodies.map((body) => body.version)).toEqual([1, 1]); controller.dispose();
  });
});

describe("preparation editor state and forms", () => {
  it("offers valid friendly defaults for every supported step", () => {
    const all = STEP_GROUPS.flatMap((group) => group.types);
    expect(new Set(all).size).toBe(17);
    for (const type of all) {
      const step = makePrepareStep(type, type, columns, { id: "customers", columns: ["Customer ID", "Customer Name"] });
      expect(pipelineDefinitionSchema.safeParse({ ...definition, steps: [step] }).success).toBe(true);
      const html = renderToStaticMarkup(createElement(StepSettings, { step, columns, sources, mainSourceId: "orders", onChange: () => {} }));
      expect(html).toContain("Selected step settings"); expect(html).not.toContain("<select");
    }
  });
  it("moves keyboard step order without changing settings and supports fifty undo entries", () => {
    const first = makePrepareStep("cleanText", "first", columns), second = makePrepareStep("derive", "second", columns);
    const source = { ...definition, steps: [first, second] };
    expect(movePipelineStep(source, "first", 1).steps).toEqual([second, first]);
    expect(source.steps).toEqual([first, second]); expect(movePipelineStep(source, "missing", 1)).toBe(source);
    let history = createPipelineHistory(source);
    for (let index = 0; index < 55; index++) history = pipelineHistoryReducer(history, { type: "set", definition: { ...source, options: { ...source.options, memoryMb: 151 + index } } });
    expect(history.past).toHaveLength(50); const changed = history.present;
    history = pipelineHistoryReducer(history, { type: "undo" }); expect(history.present).not.toEqual(changed);
    expect(pipelineHistoryReducer(history, { type: "redo" }).present).toEqual(changed);
  });
  it("renders a compound condition builder and join/quality settings without evaluating HTML", () => {
    const condition = { kind: "group" as const, operator: "and" as const, conditions: [{ kind: "condition" as const, column: "Sales", operator: "gt" as const, value: 0 }] };
    const html = renderToStaticMarkup(createElement(ConditionBuilder, { condition, columns, onChange: () => {} }));
    expect(html).toContain("Add condition"); expect(html).toContain("Condition value"); expect(html).toContain("Add group");
    const step = { ...makePrepareStep("derive", "derive", columns), name: "<script>unsafe()</script>" } as PrepareStep;
    expect(renderToStaticMarkup(createElement(StepSettings, { step, columns, sources, mainSourceId: "orders", onChange: () => {} }))).not.toContain("<script>");
  });
  it("windows a large preview and exposes changed columns and NULL values accessibly", () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({ Sales: index, Year: 2024, Note: null }));
    const html = renderToStaticMarkup(createElement(PreviewGrid, { label: "After", columns: ["Sales", "Year", "Note"], rows, changed: ["Sales"] }));
    expect(html).toContain('aria-rowcount="1001"'); expect(html).toContain("(changed)"); expect(html).toContain("—"); expect(html).toContain("2024"); expect(html).not.toContain("2,024");
    expect((html.match(/aria-rowindex=/g) ?? []).length).toBeLessThan(50); expect(html).toContain('tabindex="0"');
  });
});
