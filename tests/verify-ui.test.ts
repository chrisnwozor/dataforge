import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckResult, CheckRun } from "@/lib/verify/types";
import { CheckDetails } from "@/components/checks/check-details";
import { ChecksWorkspace } from "@/components/checks/checks-workspace";
import { checksJson } from "@/components/checks/api";
import {
  CHECK_AREAS,
  checkReportText,
  checkRunDuration,
  checkRunIsStale,
  checkRunLabel,
  countCheckResults,
  displayCheckValue,
  formatCheckNumber,
  isCheckRunActive,
  resultCountsNotice,
} from "@/components/checks/presentation";

function result(
  status: CheckResult["status"],
  patch: Partial<CheckResult> = {},
): CheckResult {
  return {
    id: `check-${status}`,
    area: "Semantic",
    name: "Sales by Category",
    status,
    expected: 1895524.97,
    actual: 1895524.98,
    difference: 0.01,
    tolerance: 0.01,
    elapsedMs: 12.25,
    explanation: "Independent SQL and the semantic result differ by 0.01.",
    nextStep: "Review numeric rounding before changing the measure.",
    sql: "SELECT SUM([Sales]) FROM [dw].[fact_sales]",
    referenceSql:
      "SELECT SUM([f].[Sales]) AS [reference] FROM [dw].[fact_sales] AS [f]",
    ...patch,
  };
}
function run(patch: Partial<CheckRun> = {}): CheckRun {
  return {
    id: "run-with-complete-id",
    projectId: "project",
    workspaceId: "workspace",
    sourceRunId: "load-1",
    modelVersion: "model-1",
    status: "succeeded",
    trigger: "manual",
    startedAt: "2026-10-28T10:00:00.000Z",
    finishedAt: "2026-10-28T10:00:02.000Z",
    total: 4,
    completed: 4,
    currentCheck: null,
    counts: { pass: 1, warn: 1, fail: 1, skipped: 1 },
    results: [
      result("pass"),
      result("warn"),
      result("fail"),
      result("skipped"),
    ],
    error: null,
    ...patch,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("data checks presentation reconciliation", () => {
  it("independently reconciles displayed per-area counts with enumerated result statuses", () => {
    const results = [
      result("pass", { area: "Ingestion" }),
      result("pass", { area: "Semantic" }),
      result("fail", { area: "Semantic" }),
      result("warn", { area: "Reports" }),
      result("skipped", { area: "Dashboards" }),
    ];
    const independentlyCounted = [0, 0, 0, 0];
    for (const entry of results)
      independentlyCounted[
        ["pass", "warn", "fail", "skipped"].indexOf(entry.status)
      ]++;
    const totals = countCheckResults(results);
    expect(Object.values(totals)).toEqual(independentlyCounted);
    expect(Object.values(totals).reduce((a, b) => a + b, 0)).toBe(
      results.length,
    );
    const areas = CHECK_AREAS.map((area) =>
      countCheckResults(results.filter((entry) => entry.area === area)),
    );
    for (const status of ["pass", "warn", "fail", "skipped"] as const)
      expect(areas.reduce((sum, area) => sum + area[status], 0)).toBe(
        totals[status],
      );
    expect(resultCountsNotice(run())).toBeNull();
  });
  it("exposes corrupt or incomplete summaries instead of making stored failures disappear", () => {
    expect(
      resultCountsNotice(
        run({ counts: { pass: 4, warn: 0, fail: 0, skipped: 0 } }),
      ),
    ).toContain("does not reconcile");
    expect(resultCountsNotice(run({ completed: 5 }))).toContain(
      "4 detailed results",
    );
    expect(checkRunLabel(run())).toBe("Discrepancies found");
    expect(checkRunLabel(run({ status: "failed" }))).toBe("Check run stopped");
    expect(checkRunLabel(run({ status: "cancelled" }))).toBe(
      "Check run cancelled",
    );
    expect(
      checkRunLabel(run({ counts: { pass: 0, warn: 0, fail: 0, skipped: 4 } })),
    ).toBe("No checks passed yet");
  });
  it("distinguishes data/model snapshots and retains explicit active states", () => {
    expect(checkRunIsStale(run(), "load-2", "model-1")).toBe(true);
    expect(checkRunIsStale(run(), "load-1", "model-2")).toBe(true);
    expect(checkRunIsStale(run(), "load-1", "model-1")).toBe(false);
    expect(checkRunIsStale(run())).toBe(false);
    expect(checkRunIsStale(run(), null, "model-1")).toBe(true);
    expect(isCheckRunActive(run({ status: "running" }))).toBe(true);
    expect(isCheckRunActive(run({ status: "queued" }))).toBe(true);
    expect(isCheckRunActive(run())).toBe(false);
    expect(isCheckRunActive(null)).toBe(false);
  });
  it("reconciles elapsed time with an independent timestamp subtraction", () => {
    const start = Date.UTC(2026, 9, 28, 10, 0, 0),
      end = Date.UTC(2026, 9, 28, 10, 0, 2);
    expect(checkRunDuration(run())).toBe(end - start);
    expect(checkRunDuration(run({ finishedAt: null }), end + 125)).toBe(2125);
    expect(
      checkRunDuration(run({ finishedAt: "2026-10-28T09:00:00.000Z" })),
    ).toBe(0);
    expect(
      checkRunDuration({ startedAt: "invalid", finishedAt: null }, end),
    ).toBe(0);
  });
});

describe("readable values and plain-text reports", () => {
  it("does not group years, identifiers or integer counts and keeps negative formatting consistent", () => {
    expect(formatCheckNumber(2024)).toBe("2024");
    expect(formatCheckNumber(2003)).toBe("2003");
    expect(formatCheckNumber(-12.5)).toBe("-12.50");
    expect(formatCheckNumber(12.5)).toBe("12.50");
    expect(formatCheckNumber(0.00000003)).toBe("3.000000e-8");
    expect(formatCheckNumber(-0)).toBe("0");
    expect(formatCheckNumber(null)).toBe("—");
    expect(formatCheckNumber(Number.NaN)).toBe("—");
    expect(displayCheckValue("000012345")).toBe("000012345");
    expect(displayCheckValue("")).toBe("(empty string)");
    expect(displayCheckValue({ Year: 2024, ID: "000012345" })).toContain(
      '"Year": 2024',
    );
    expect(displayCheckValue(false)).toBe("false");
  });
  it("copies complete results, failures, raw SQL and next steps without HTML", () => {
    const text = checkReportText(
      run({ error: "Some references were unavailable." }),
    );
    expect(text).toContain("FAIL · Semantic · Sales by Category");
    expect(text).toContain("run-with-complete-id");
    expect(text).toContain("Load: load-1");
    expect(text).toContain("Model: model-1");
    expect(text).toContain("pass: 1 · warn: 1 · fail: 1 · skipped: 1");
    expect(text).toContain("Expected: 1895524.97");
    expect(text).toContain("Actual: 1895524.98");
    expect(text).toContain("Difference: 0.01");
    expect(text).toContain(
      "Next step: Review numeric rounding before changing the measure.",
    );
    expect(text).toContain("Independent reference SQL:");
    expect(text).toContain("Some references were unavailable.");
    expect(text).not.toContain("<table");
  });
  it("renders every failure value and SQL as selectable escaped text with no truncation", () => {
    const full = "This is a very long check name ".repeat(40),
      html = renderToStaticMarkup(
        createElement(CheckDetails, {
          result: result("fail", {
            name: full,
            expected: "<script>alert('never')</script>",
            nextStep: "",
          }),
        }),
      );
    expect(html).toContain(full.trim());
    expect(html).toContain("Expected");
    expect(html).toContain("Actual");
    expect(html).toContain("Tolerance");
    expect(html).toContain("Independent reference SQL");
    expect(html).toContain("Inspect the expected and actual values");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("text-overflow");
  });
});

describe("Checks shell and request behavior", () => {
  it("renders the guarded page's interactive shell without initiating a query in render", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const html = renderToStaticMarkup(
      createElement(ChecksWorkspace, { projectId: "project" }),
    );
    expect(html).toContain("Run all");
    expect(html).toContain("Loading check history");
    expect(html).toContain("Run checks after every successful load");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forwards abort signals and keeps existing results when a request rejects", async () => {
    const controller = new AbortController(),
      payload = { run: run() };
    const fetcher = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await checksJson("/checks/run", { signal: controller.signal }),
    ).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith("/checks/run", {
      cache: "no-store",
      signal: controller.signal,
    });
    fetcher.mockResolvedValueOnce(
      Response.json({ error: "Sign in to continue." }, { status: 401 }),
    );
    await expect(checksJson("/checks/run")).rejects.toThrow(
      "Sign in to continue.",
    );
    expect(payload.run.results).toHaveLength(4);
  });
  it("sets a readable floor and wraps long identifiers and SQL at mobile/zoom widths", () => {
    const css = readFileSync(
      join(process.cwd(), "components/checks/checks.module.css"),
      "utf8",
    );
    expect(css).toMatch(/font-size:\s*14px/);
    expect(css).toMatch(/font-size:\s*12px/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/white-space:\s*pre-wrap/);
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(css).not.toMatch(/font-size:\s*(?:[0-9]|1[01])px/);
    expect(css).toContain("prefers-reduced-motion");
  });
});

describe("Checks theme contrast", () => {
  it("reconciles every text/status palette against independent WCAG luminance calculations in both themes", () => {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
    const luminance = (input: string) => {
      const hex =
        input.length === 4
          ? "#" + [...input.slice(1)].map((char) => char + char).join("")
          : input;
      const channels = [1, 3, 5].map(
        (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255,
      );
      const linear = channels.map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      );
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    for (const selector of [":root", ".dark"]) {
      const block = css.slice(css.indexOf(selector + " {"));
      const variables = Object.fromEntries(
        [
          ...block
            .slice(0, block.indexOf("}"))
            .matchAll(/(--[\w-]+):\s*(#[a-fA-F0-9]{3,6})/g),
        ].map((match) => [match[1], match[2]]),
      );
      for (const [text, surface] of [
        ["--text", "--surface"],
        ["--muted", "--surface"],
        ["--green", "--green-bg"],
        ["--amber", "--amber-bg"],
        ["--red", "--red-bg"],
      ]) {
        const values = [
          luminance(variables[text]),
          luminance(variables[surface]),
        ].sort((a, b) => b - a);
        const contrast = (values[0] + 0.05) / (values[1] + 0.05);
        expect(
          contrast,
          `${selector}: ${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
