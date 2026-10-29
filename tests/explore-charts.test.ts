import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExploreChart } from "@/components/charts/explore-chart";
import { bandScale, compactTick, donutArc, finiteValues, lineSegments, linearScale, niceTicks, numericDomain, shortenLabel, fitAxisLabel } from "@/components/charts/scales";

describe("Explore SVG scales", () => {
  it("generates readable, bounded ticks spanning positive, negative and decimal domains", () => {
    expect(niceTicks(0, 98)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-27, 13)).toEqual([-30, -20, -10, 0, 10, 20]);
    expect(niceTicks(0, 0.008)).toEqual([0, 0.002, 0.004, 0.006, 0.008]);
    for (const [min, max] of [[10, 10], [0, 0], [2e12, 9e12], [-0.000002, 0.000003]]) {
      const ticks = niceTicks(min, max);
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.length).toBeLessThan(20);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
      expect(ticks.every(Number.isFinite)).toBe(true);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });
  it("handles reversed domains and invalid observations", () => {
    expect(niceTicks(100, 0)).toEqual(niceTicks(0, 100));
    expect(niceTicks(NaN, Infinity).every(Number.isFinite)).toBe(true);
    expect(finiteValues([null, NaN, Infinity, -Infinity, 0, 22])).toEqual([0, 22]);
    expect(numericDomain([null, NaN])).toEqual([0, 1]);
    expect(numericDomain([-8, 2])).toEqual([-8, 2]);
    expect(numericDomain([20, 40])).toEqual([0, 40]);
    expect(numericDomain([20, 40], false)).toEqual([20, 40]);
    expect(numericDomain([4, 4], false)).toEqual([3.6, 4.4]);
  });
  it("keeps extreme finite and subnormal domains bounded without NaN ticks", () => {
    for (const [min, max] of [[-Number.MAX_VALUE, Number.MAX_VALUE], [1e308, Number.MAX_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE], [0, Number.MIN_VALUE], [-Number.MIN_VALUE, Number.MIN_VALUE]]) {
      const ticks = niceTicks(min, max);
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.length).toBeLessThanOrEqual(100);
      expect(ticks.every(Number.isFinite)).toBe(true);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
    }
    expect(linearScale([-Number.MAX_VALUE, Number.MAX_VALUE], [0, 100])(0)).toBe(50);
    expect(linearScale([0, Number.MIN_VALUE], [0, 100])(Number.MIN_VALUE)).toBe(100);
    expect(numericDomain([Number.MAX_VALUE], false).every(Number.isFinite)).toBe(true);
    expect(compactTick(1e38)).toBe("1E38");
  });
  it("maps linear and band scales without losing signed zero baselines", () => {
    const scale = linearScale([-20, 80], [300, 0]);
    expect(scale(-20)).toBe(300);
    expect(scale(80)).toBe(0);
    expect(scale(0)).toBe(240);
    expect(scale(NaN)).toBe(300);
    expect(linearScale([4, 4], [10, 90])(4)).toBe(50);
    const band = bandScale(4, 0, 400, 0.2);
    expect(band.bandwidth).toBe(80);
    expect(band.at(0)).toBe(10);
    expect(band.center(3)).toBe(350);
    expect(bandScale(0, 0, 400).bandwidth).toBe(320);
  });
  it("formats compact ticks and keeps long labels bounded", () => {
    expect(compactTick(25_000)).toBe("25K");
    expect(compactTick(0.25)).toBe("0.25");
    expect(shortenLabel("Furniture and office supplies", 12)).toBe("Furniture a…");
    expect(shortenLabel("2022")).toBe("2022");
  });
  it("fits axis labels to available width without splitting Unicode characters", () => {
    expect(fitAxisLabel("Office Supplies", 62)).toBe("Office Su…");
    expect(fitAxisLabel("Consumer", 100)).toBe("Consumer");
    expect(fitAxisLabel("2024", 28)).toBe("2024");
    expect(fitAxisLabel("Furniture", 0)).toBe("…");
    expect(fitAxisLabel("📦📦📦📦📦📦", 25)).toBe("📦📦📦…");
  });
  it("breaks line and area paths at nulls instead of fabricating observations", () => {
    const a = { x: 1, y: 2 }, b = { x: 3, y: 4 }, c = { x: 8, y: 9 };
    expect(lineSegments([null, a, b, null, { x: NaN, y: 2 }, c, null])).toEqual([[a, b], [c]]);
    expect(lineSegments([null])).toEqual([]);
  });
  it("produces finite, closed donut sectors including one full-circle slice", () => {
    const quarter = donutArc(0, Math.PI / 2, 100, 60);
    expect(quarter).toContain("M100,0");
    expect(quarter).toContain("A100,100 0 0 1 0,100");
    expect(quarter).toContain("L0,60");
    expect(quarter).toMatch(/ Z$/);
    const full = donutArc(0, 2 * Math.PI);
    expect(full).not.toMatch(/NaN|Infinity/);
    expect(full).toContain("0 1 1");
  });
});

describe("Explore SVG chart accessibility and bounded rendering", () => {
  const data = [
    { key: "furniture", label: "Furniture", values: { sales: 100, profit: 12 } },
    { key: "office", label: "Office Supplies", values: { sales: 75, profit: -4 } },
    { key: "technology", label: "Technology", values: { sales: null, profit: 20 } },
  ];
  const series = [{ key: "sales", label: "Sales" }, { key: "profit", label: "Profit" }];
  for (const kind of ["bar", "line", "area", "donut", "kpi"] as const) {
    it(`${kind} has a named SVG, text summary, keyboard marks and data fallback`, () => {
      const html = renderToStaticMarkup(createElement(ExploreChart, { kind, data, series, title: "Sales by Category", onMemberClick: () => {} }));
      expect(html).toContain("data-explore-chart=\"true\"");
      expect(html).toContain("role=\"group\"");
      expect(html).toContain("aria-roledescription=\"chart\"");
      expect(html).toContain("Sales by Category");
      expect(html).toContain("3 categories and 2 measures");
      expect(html).toContain("View accessible data table");
      expect(html).toContain("tabindex=\"0\"");
      expect(html).toContain("role=\"button\"");
      expect(html).not.toMatch(/NaN|Infinity/);
    });
  }
  it("truncates long bar axis labels and exposes complete labels in native SVG tooltips", () => {
    const label = "Furniture and office supplies with a very long category description";
    for (const horizontal of [false, true]) {
      const html = renderToStaticMarkup(createElement(ExploreChart, { kind: "bar", data: [{ key: "long", label, values: { sales: 10 } }, ...data], series: [series[0]], title: "Long categories", horizontal }));
      const axis = html.match(/<text[^>]*>[^<]*…<title>[^<]+<\/title><\/text>/g) ?? [];
      expect(axis.length).toBeGreaterThan(0);
      expect(axis.some((text) => text.includes(`<title>${label}</title>`))).toBe(true);
      expect(html).toContain(`aria-label="${label}, Sales: 10"`);
    }
  });
  it("opts dashboard charts into a container-sized frame while preserving accessible data", () => {
    const fitted = renderToStaticMarkup(createElement(ExploreChart, { kind: "line", data, series, title: "Dashboard sales", fitToContainer: true }));
    expect(fitted).toContain('data-chart-fit="true"');
    expect(fitted).toContain("View accessible data table");
    expect(fitted).toContain("3 categories and 2 measures");
    const normal = renderToStaticMarkup(createElement(ExploreChart, { kind: "line", data, series, title: "Explore sales" }));
    expect(normal).not.toContain("data-chart-fit");
  });
  it("caps marks without silently discarding the full table", () => {
    const big = Array.from({ length: 50_000 }, (_, index) => ({ key: String(index), label: `Product ${index}`, values: { sales: index } }));
    const html = renderToStaticMarkup(createElement(ExploreChart, { kind: "bar", data: big, series: [series[0]], title: "All products" }));
    expect(html).toContain("Showing the first 200 of 50,000 categories");
    expect((html.match(/<rect/g) ?? []).length).toBe(200);
    expect(html).toContain("50,000 rows");
  });
  it("bounds a wide pivot to twelve SVG series rather than multiplying thousands of marks", () => {
    const wideSeries = Array.from({ length: 3_200 }, (_, index) => ({ key: `s${index}`, label: `Series ${index}` }));
    const values = Object.fromEntries(wideSeries.map((item) => [item.key, 5]));
    const rows = Array.from({ length: 250 }, (_, index) => ({ key: String(index), label: `Product ${index}`, values }));
    const html = renderToStaticMarkup(createElement(ExploreChart, { kind: "bar", data: rows, series: wideSeries, title: "Wide pivot" }));
    expect((html.match(/<rect/g) ?? []).length).toBe(200 * 12);
    expect(html).toContain("Showing the first 12 of 3,200 measure series");
    expect(html).toContain("eight columns per page");
    expect((html.match(/<li>/g) ?? []).length).toBe(12);
  });
  it("renders an honest empty state and ignores untrusted color expressions", () => {
    const html = renderToStaticMarkup(createElement(ExploreChart, { kind: "line", data: [], series, title: "No observations" }));
    expect(html).toContain("No values to display");
    const color = renderToStaticMarkup(createElement(ExploreChart, { kind: "bar", data, series, title: "Color", colors: ["url(https://untrusted.invalid/a)"] }));
    expect(color).not.toContain("untrusted.invalid");
    expect(color).toContain("var(--blue)");
  });
});
