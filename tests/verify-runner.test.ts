import { describe, expect, it, vi } from "vitest";
import { runChecks } from "@/lib/verify/runner";
import { checkRunCsv, checkRunText } from "@/lib/verify/export";
import { compareNumbers, compareQueryResults } from "@/lib/verify/compare";
import type { CheckCase, CheckOutcome, CheckRun } from "@/lib/verify/types";
const outcome = (status: CheckOutcome["status"]): CheckOutcome => ({
  status,
  expected: 12,
  actual: status === "fail" ? 13 : 12,
  difference: status === "fail" ? 1 : 0,
  tolerance: 0.01,
  explanation:
    "An independent integer-cent calculation was compared with the actual value.",
  nextStep: "Inspect the differing row.",
  sql: "SELECT actual",
  referenceSql: "SELECT independent",
});
describe("serial cancellable check runner", () => {
  it("emits every status, captures errors and reconciles progress independently", async () => {
    let active = 0,
      max = 0;
    const checks: CheckCase[] = ["pass", "warn", "fail", "skipped"].map(
      (status, i) => ({
        id: String(i),
        area: "Semantic",
        name: status,
        run: async () => {
          active++;
          max = Math.max(max, active);
          await Promise.resolve();
          active--;
          return outcome(status as CheckOutcome["status"]);
        },
      }),
    );
    checks.push({
      id: "bad",
      area: "Ingestion",
      name: "driver error",
      run: async () => {
        throw Object.assign(new Error("driver failed SECRET"), {
          sql: "SELECT attempted",
        });
      },
    });
    const recorded: string[] = [];
    const result = await runChecks(checks, {
      signal: new AbortController().signal,
      onResult: (r) => {
        recorded.push(r.status);
      },
      redact: (m) => m.replace("SECRET", "[redacted]"),
    });
    expect(recorded).toEqual(["pass", "warn", "fail", "skipped", "fail"]);
    expect(max).toBe(1);
    expect(result[4]).toMatchObject({
      status: "fail",
      sql: "SELECT attempted",
      explanation: expect.stringContaining("[redacted]"),
    });
    expect(
      result.reduce(
        (counts, r) => ({ ...counts, [r.status]: (counts[r.status] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    ).toEqual({ pass: 1, warn: 1, fail: 2, skipped: 1 });
  });
  it("retains prior progress and stops immediately on cancellation", async () => {
    const controller = new AbortController(),
      persisted: string[] = [];
    const cases: CheckCase[] = [
      {
        id: "one",
        name: "one",
        area: "Ingestion",
        run: async () => outcome("pass"),
      },
      {
        id: "two",
        name: "two",
        area: "Semantic",
        run: async () => {
          controller.abort(new Error("cancel"));
          return outcome("pass");
        },
      },
    ];
    await expect(
      runChecks(cases, {
        signal: controller.signal,
        onResult: (r) => {
          persisted.push(r.id);
        },
      }),
    ).rejects.toThrow("cancel");
    expect(persisted).toEqual(["one"]);
  });
  it("records interactive preemption as unverified, not a pass", async () => {
    const result = await runChecks(
      [
        {
          id: "q",
          name: "q",
          area: "Semantic",
          run: async () => {
            throw new Error(
              "A newer main query replaced this lower-priority request.",
            );
          },
        },
      ],
      { signal: new AbortController().signal },
    );
    expect(result[0].status).toBe("skipped");
    expect(result[0].explanation).toMatch(/No correctness/);
  });
  it("rejects an already-aborted run without touching a driver", async () => {
    const fn = vi.fn(),
      controller = new AbortController();
    controller.abort();
    await expect(
      runChecks([{ id: "q", name: "q", area: "Semantic", run: fn }], {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
describe("independent result comparisons and exports", () => {
  it("keeps null different from zero and evaluates absolute and relative tolerances", () => {
    expect(compareNumbers(null, 0).equal).toBe(false);
    expect(compareNumbers(100, 100.009).equal).toBe(true);
    expect(compareNumbers(100, 100.02).equal).toBe(false);
    expect(compareNumbers(1e8, 1e8 + 10).equal).toBe(true);
    expect(compareNumbers(Infinity, Infinity).equal).toBe(false);
  });
  it("matches by member rather than physical order and fails missing/duplicate groups", () => {
    const columns = [
      {
        key: "g",
        name: "Category",
        role: "attribute" as const,
        type: "string" as const,
      },
      {
        key: "v",
        name: "Sales",
        role: "measure" as const,
        type: "number" as const,
      },
    ];
    const reference = {
      sql: "SELECT independent",
      params: [],
      columns,
      limit: 50,
    };
    const actual = {
      columns,
      rows: [
        { g: "B", v: 20 },
        { g: "A", v: 10 },
      ],
      rowCount: 2,
      truncated: false,
      elapsedMs: 0,
      fromCache: false,
      sql: "SELECT engine",
    };
    expect(
      compareQueryResults(actual, reference, [
        { g: "A", v: 10 },
        { g: "B", v: 20 },
      ]).status,
    ).toBe("pass");
    expect(
      compareQueryResults(actual, reference, [{ g: "A", v: 10 }]).status,
    ).toBe("fail");
    expect(() =>
      compareQueryResults(
        {
          ...actual,
          rows: [
            { g: "A", v: 10 },
            { g: "A", v: 20 },
          ],
        },
        reference,
        [{ g: "A", v: 10 }],
      ),
    ).toThrow(/duplicate/);
    expect(
      compareQueryResults({ ...actual, truncated: true }, reference, []).status,
    ).toBe("skipped");
  });
  it("exports failures and full SQL without CSV formula injection", () => {
    const run: CheckRun = {
      id: "run-id",
      projectId: "project",
      workspaceId: "workspace",
      sourceRunId: null,
      modelVersion: "v1",
      status: "succeeded",
      trigger: "manual",
      startedAt: "2026-10-01T00:00:00Z",
      finishedAt: "2026-10-01T00:01:00Z",
      total: 1,
      completed: 1,
      currentCheck: null,
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0 },
      error: null,
      results: [
        {
          ...outcome("fail"),
          id: "=formula",
          area: "Semantic",
          name: "Sales",
          elapsedMs: 12.4,
        },
      ],
    };
    const csv = checkRunCsv(run);
    expect(csv).toContain('"\'=formula"');
    expect(csv).toContain("SELECT independent");
    expect(checkRunText(run)).toContain("FAIL · Semantic · Sales");
    expect(checkRunText(run)).toContain("Expected: 12; actual: 13");
  });
});
