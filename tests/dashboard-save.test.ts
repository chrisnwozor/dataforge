import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardSaveController } from "@/components/dashboards/use-dashboard-save";
import { createEmptyDashboard, type SavedDashboard } from "@/lib/dashboards/schema";
const initial = (): SavedDashboard => ({ ...createEmptyDashboard("A"), id: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-28T12:00:00.000Z", updatedAt: "2026-10-28T12:00:00.000Z" });
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("dashboard serialized autosave", () => {
  it("saves an undo back to the original while a different write is in flight", async () => {
    const requests: { body: Record<string, unknown>; finish: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((finish) => requests.push({ body: JSON.parse(String(init.body)), finish })));
    const controller = new DashboardSaveController("/dashboard", initial());
    controller.configure(createEmptyDashboard("B"));
    await vi.advanceTimersByTimeAsync(600); expect(requests).toHaveLength(1);
    controller.configure(createEmptyDashboard("A"));
    requests[0].finish(Response.json({ updatedAt: "2026-10-28T12:00:01.000Z" })); await flush();
    expect(controller.getSnapshot().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(100); expect(requests).toHaveLength(2);
    expect(requests[1].body.name).toBe("A"); expect(requests[1].body.updatedAt).toBe("2026-10-28T12:00:01.000Z");
    requests[1].finish(Response.json({ updatedAt: "2026-10-28T12:00:02.000Z" })); await flush();
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, status: "saved" }); controller.dispose();
  });
  it("debounces edits and serializes only the latest pending document", async () => {
    const requests: { body: Record<string, unknown>; finish: (response: Response) => void }[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((finish) => requests.push({ body: JSON.parse(String(init.body)), finish })));
    const controller = new DashboardSaveController("/dashboard", initial());
    controller.configure(createEmptyDashboard("B")); controller.configure(createEmptyDashboard("C"));
    await vi.advanceTimersByTimeAsync(600); expect(requests[0].body.name).toBe("C");
    controller.configure(createEmptyDashboard("D")); controller.configure(createEmptyDashboard("E"));
    await vi.advanceTimersByTimeAsync(1000); expect(requests).toHaveLength(1);
    requests[0].finish(Response.json({ updatedAt: "2026-10-28T12:00:01.000Z" })); await flush();
    await vi.advanceTimersByTimeAsync(100); expect(requests[1].body.name).toBe("E");
    requests[1].finish(Response.json({ updatedAt: "2026-10-28T12:00:02.000Z" })); await flush();
    expect(controller.getSnapshot().status).toBe("saved"); controller.dispose();
  });
  it("preserves edits after a conflict and retries without inventing a new revision", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ error: "Changed in another tab." }, { status: 409 })).mockResolvedValueOnce(Response.json({ updatedAt: "2026-10-28T12:00:01.000Z" }));
    vi.stubGlobal("fetch", fetch); const controller = new DashboardSaveController("/dashboard", initial());
    controller.configure(createEmptyDashboard("B")); await vi.advanceTimersByTimeAsync(600);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", dirty: true, error: "Changed in another tab." });
    controller.retry(); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ name: "B", updatedAt: initial().updatedAt });
    expect(controller.getSnapshot().status).toBe("saved"); controller.dispose();
  });
});
