import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportSaveController } from "@/components/reports/use-report-save";
import { ReportParameters } from "@/components/reports/report-parameters";
import { ReportPreview } from "@/components/reports/report-preview";
import { ReportProperties } from "@/components/reports/report-properties";
import { createEmptyReport, type ReportDocument, type SavedReport } from "@/lib/reports/schema";
import type { PaginatedReport } from "@/lib/reports/pagination";

const document = createEmptyReport("Sales report");
const saved: SavedReport = { ...document, id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const updated = (document: ReportDocument, ordinal = 1): SavedReport => ({ ...saved, ...document, updatedAt: `2026-01-01T00:00:0${ordinal}.000Z` });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("serialized report autosave", () => {
  it("debounces to the latest edit and passes the optimistic revision", async () => {
    vi.useFakeTimers(); const requests: unknown[] = [];
    const controller = new ReportSaveController("/reports/report", saved, async (_url, body) => { requests.push(body); return updated(body as ReportDocument); });
    controller.update({ ...document, name: "First" });
    controller.update({ ...document, name: "Latest" });
    await vi.advanceTimersByTimeAsync(649); expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toEqual([{ ...document, name: "Latest", updatedAt: saved.updatedAt }]);
    expect(controller.getSnapshot().status).toBe("saved"); expect(controller.isDirty()).toBe(false); controller.dispose();
  });
  it("persists an undo to the old saved document after an intermediate PUT finishes", async () => {
    const pending = deferred<SavedReport>(); const requests: unknown[] = [];
    const intermediate = { ...document, name: "Intermediate" };
    const controller = new ReportSaveController("/reports/report", saved, async (_url, body) => { requests.push(body); return requests.length === 1 ? pending.promise : updated(body as ReportDocument, 2); });
    controller.update(intermediate); const flushing = controller.flush();
    controller.update(document); expect(controller.isDirty()).toBe(true);
    pending.resolve(updated(intermediate)); await flushing;
    expect(requests).toEqual([{ ...intermediate, updatedAt: saved.updatedAt }, { ...document, updatedAt: "2026-01-01T00:00:01.000Z" }]);
    expect(controller.getSnapshot().status).toBe("saved"); expect(controller.isDirty()).toBe(false); controller.dispose();
  });
  it("keeps conflicting edits dirty for an explicit retry without overwriting their revision", async () => {
    let calls = 0; const revisions: unknown[] = [];
    const controller = new ReportSaveController("/reports/report", saved, async (_url, body) => { calls++; revisions.push((body as { updatedAt: string }).updatedAt); if (calls === 1) throw new Error("This report changed in another tab."); return updated(body as ReportDocument); });
    controller.update({ ...document, description: "Edited" }); expect(await controller.flush()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", error: expect.stringContaining("another tab") });
    expect(controller.isDirty()).toBe(true); expect(await controller.flush()).toBe(true); expect(revisions).toEqual([saved.updatedAt, saved.updatedAt]); controller.dispose();
  });
});

describe("report leaves", () => {
  it("does not prefetch parameter values while the picker is closed", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const definition = { ...document.definition, parameters: [{ id: "category", name: "Category", type: "multi" as const, attribute: { table: "product", column: "category" }, allowAll: true, default: null }] };
    const html = renderToStaticMarkup(createElement(ReportParameters, { projectId: saved.projectId, definition, values: {}, model: null, onChange: () => {} }));
    expect(html).toContain("Category: All values"); expect(html).toContain('aria-expanded="false"'); expect(fetch).not.toHaveBeenCalled();
  });
  it("renders a complete page with selectable text, row labels, and no orphan table ARIA roles", () => {
    const report: PaginatedReport = { width: 595, height: 842, pages: [{ number: 1, elements: [
      { kind: "text", x: 30, y: 30, width: 500, height: 30, text: "Sales by Category", fontSize: 18, role: "header" },
      { kind: "tableHeader", itemId: "table", x: 30, y: 80, width: 500, height: 22, cells: [{ text: "Category", raw: "Category", width: 250, align: "left", format: "auto" }, { text: "Sales", raw: "Sales", width: 250, align: "right", format: "currency" }] },
      { kind: "tableRow", rowKind: "detail", itemId: "table", x: 30, y: 102, width: 500, height: 22, cells: [{ text: "Furniture", raw: "Furniture", width: 250, align: "left", format: "auto" }, { text: "$2,000", raw: 2000, width: 250, align: "right", format: "currency" }] },
    ] }], rowCount: 1, truncated: false, warnings: [], title: "Sales report", runAt: saved.createdAt };
    const html = renderToStaticMarkup(createElement(ReportPreview, { report }));
    expect(html).toContain("Sales by Category"); expect(html).toContain("Furniture"); expect(html).toContain("$2,000"); expect(html).toContain('aria-label="Page 1 of 1"'); expect(html).not.toMatch(/role="(?:row|cell|columnheader)"/);
  });
  it("exposes page, item, parameter settings and marks unblurred text drafts for navigation protection", () => {
    const item = { type: "text" as const, id: "note", title: "Notes", content: "Plain text" };
    const html = renderToStaticMarkup(createElement(ReportProperties, { document: { ...document, definition: { ...document.definition, items: [item] } }, item, model: null, views: [], onChange: () => {}, onItemChange: () => {} }));
    expect(html).toContain("Parameters"); expect(html).toContain("Text block content"); expect(html).toContain('data-report-draft="true"'); expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});
