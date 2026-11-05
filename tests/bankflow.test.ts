import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bankflow, screenshots } from "@/content/bankflow";
import { BankFlowMetrics } from "@/components/bankflow/BankFlowMetrics";
import { wrapScreenshotIndex } from "@/components/bankflow/gallery-keyboard";

describe("BankFlow verified figures", () => {
  it("reconciles the published source count against independent record totals", () => {
    const published = Object.fromEntries(bankflow.metrics.map(({ id, value }) => [id, value]));
    // These expected values come directly from the supplied project evidence,
    // independently of the content module and its presentation.
    const sourceRecords = 385;
    const acceptedRecords = 378;
    const isolatedRecords = 7;
    const goldTables = 7;
    expect(published.source).toBe(sourceRecords);
    expect(published.validated).toBe(acceptedRecords);
    expect(published.quarantined).toBe(isolatedRecords);
    expect(published.goldTables).toBe(goldTables);
    expect(published.validated + published.quarantined).toBe(sourceRecords);
    expect(published.source - published.validated).toBe(isolatedRecords);
  });

  it("renders final values on the server without needing JavaScript", () => {
    const markup = renderToStaticMarkup(createElement(BankFlowMetrics));
    const renderedValues = Array.from(markup.matchAll(/<dd>(\d+)<\/dd>/g), (match) =>
      Number(match[1]),
    );
    expect(renderedValues).toEqual([385, 378, 7, 7]);
    expect(renderedValues[1] + renderedValues[2]).toBe(renderedValues[0]);
    expect(markup).toContain("Source records");
    expect(markup).toContain("Quarantined records");
  });

  it("does not ship illustrative screenshots as project evidence", () => {
    for (const screenshot of screenshots) {
      expect(screenshot.src).toMatch(/^\/case-studies\/bankflow\//);
      expect(screenshot.alt.trim().length).toBeGreaterThan(0);
      expect(screenshot.caption.trim().length).toBeGreaterThan(0);
      expect(screenshot.width).toBeGreaterThan(0);
      expect(screenshot.height).toBeGreaterThan(0);
    }
    expect(bankflow.demonstrationLabel).toContain("personal demonstration");
    expect(bankflow.demonstrationLabel).toContain("sample banking transaction data");
  });
});

describe("screenshot keyboard navigation", () => {
  it("moves through the viewer and wraps at either end", () => {
    expect(wrapScreenshotIndex(1, 3)).toBe(1);
    expect(wrapScreenshotIndex(3, 3)).toBe(0);
    expect(wrapScreenshotIndex(-1, 3)).toBe(2);
    expect(wrapScreenshotIndex(1, 1)).toBe(0);
    expect(wrapScreenshotIndex(-1, 1)).toBe(0);
  });
});
