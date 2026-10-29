import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyReport } from "@/lib/reports/schema";
import { prepareReportSchedule } from "@/lib/server/report-schedule-http";
import { getReport, type ReportSchedule } from "@/lib/server/reports";

vi.mock("@/lib/server/reports", async (original) => ({ ...await original<typeof import("@/lib/server/reports")>(), getReport: vi.fn() }));
const now = new Date("2026-10-29T12:00:00Z");
const input = { cron: "0 9 * * *", timezone: "America/New_York", params: {}, formats: ["pdf"], enabled: true };
const saved: ReportSchedule = { ...input, id: "schedule", projectId: "project", reportId: "report", formats: ["pdf"], params: {}, lastRunAt: null, nextRunAt: "2026-10-29T13:00:00.000Z" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getReport).mockReturnValue({ ...createEmptyReport(), id: "report", projectId: "project", createdAt: now.toISOString(), updatedAt: now.toISOString() }); });

describe("server-owned report schedule configuration", () => {
  it("validates project-scoped report and calculates the next timezone occurrence", () => {
    expect(prepareReportSchedule("project", "report", input, undefined, now)).toMatchObject({ ...input, lastRunAt: null, nextRunAt: "2026-10-29T13:00:00.000Z" });
    expect(getReport).toHaveBeenCalledWith("project", "report");
  });

  it("preserves saved parameters and enabled state when changing only formats", () => {
    const report = { ...createEmptyReport(), id: "report", projectId: "project", createdAt: now.toISOString(), updatedAt: now.toISOString() };
    report.definition.parameters = [{ id: "category", name: "Category", type: "single", attribute: { table: "product", column: "category" }, allowAll: true }];
    vi.mocked(getReport).mockReturnValue(report);
    const result = prepareReportSchedule("project", "report", { formats: ["csv"] }, { ...saved, enabled: false, params: { category: "Furniture" }, nextRunAt: null }, now);
    expect(result.params).toEqual({ category: "Furniture" });
    expect(result.enabled).toBe(false); expect(result.nextRunAt).toBeNull();
  });

  it("recomputes next run only when timing or enablement changes", () => {
    expect(prepareReportSchedule("project", "report", { formats: ["xlsx"] }, saved, now).nextRunAt).toBe(saved.nextRunAt);
    expect(prepareReportSchedule("project", "report", { cron: "0 10 * * *" }, saved, now).nextRunAt).toBe("2026-10-29T14:00:00.000Z");
    expect(prepareReportSchedule("project", "report", { enabled: false }, saved, now).nextRunAt).toBeNull();
  });

  it.each([
    { ...input, nextRunAt: "2027-01-01T00:00:00.000Z" },
    { ...input, lastRunAt: "2026-01-01T00:00:00.000Z" },
    { ...input, sql: "SELECT 1" },
    { ...input, cron: "* * * * * *" },
    { ...input, cron: "0 0 30 2 *" },
    { ...input, timezone: "Bad/Timezone" },
    { ...input, formats: ["pdf", "pdf"] },
    { ...input, params: { unknown: "x" } },
  ])("rejects invalid or client-controlled schedule fields", (value) => expect(() => prepareReportSchedule("project", "report", value, undefined, now)).toThrow());

  it("rejects missing required parameter values before a schedule is stored", () => {
    const report = { ...createEmptyReport(), id: "report", projectId: "project", createdAt: now.toISOString(), updatedAt: now.toISOString() };
    report.definition.parameters = [{ id: "region", name: "Region", type: "single", attribute: { table: "region", column: "name" }, allowAll: false }];
    vi.mocked(getReport).mockReturnValue(report);
    expect(() => prepareReportSchedule("project", "report", input, undefined, now)).toThrow(/parameters/);
    expect(prepareReportSchedule("project", "report", { ...input, params: { region: "East" } }, undefined, now).params).toEqual({ region: "East" });
  });
});
