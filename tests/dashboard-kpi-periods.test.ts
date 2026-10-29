import { beforeAll, describe, expect, it } from "vitest";
import { comparisonPeriodType, kpiDateAttribute, latestCompletePeriod, periodFilters, periodTypeForSelection } from "@/lib/dashboards/kpi-periods";
import { formatMeasure } from "@/lib/explore/format";
import type { SemanticModel } from "@/lib/semantic/types";
import { createSuperstoreSemanticFixture } from "./fixtures/superstore-semantic";
import { readSuperstoreRows } from "./fixtures/superstore-results";

let model: SemanticModel;
beforeAll(async () => { model = await createSuperstoreSemanticFixture(); });

describe("KPI complete calendar periods", () => {
  it("keeps the default big number all-time and resolves the three explicit period choices", () => {
    expect(periodTypeForSelection(undefined)).toBeNull();
    expect(periodTypeForSelection("all")).toBeNull();
    expect(periodTypeForSelection("latestYear")).toBe("year");
    expect(periodTypeForSelection("latestQuarter")).toBe("quarter");
    expect(periodTypeForSelection("latestMonth")).toBe("month");
  });

  it("selects the latest fully closed year instead of the partial year containing the final fact date", () => {
    expect(latestCompletePeriod("2025-07-08", "year")).toEqual({ start: "2024-01-01", end: "2024-12-31", label: "2024", previousLabel: "2023" });
    expect(latestCompletePeriod("2024-12-31", "year")).toEqual({ start: "2024-01-01", end: "2024-12-31", label: "2024", previousLabel: "2023" });
    expect(latestCompletePeriod("2025-01-01", "year")?.label).toBe("2024");
  });


  it("includes closed historical periods even when there were no sales on their final day", () => {
    expect(latestCompletePeriod("2024-12-30", "year", "2026-10-28")).toEqual({ start: "2024-01-01", end: "2024-12-31", label: "2024", previousLabel: "2023" });
    expect(latestCompletePeriod("2026-09-26", "quarter", "2026-10-28")).toEqual({ start: "2026-07-01", end: "2026-09-30", label: "Q3 2026", previousLabel: "Q2 2026" });
    expect(latestCompletePeriod("2026-09-26", "month", "2026-10-28")).toEqual({ start: "2026-09-01", end: "2026-09-30", label: "Sep 2026", previousLabel: "Aug 2026" });
    expect(latestCompletePeriod("2026-09-26", "year", "2026-10-28")?.label).toBe("2025");
    expect(latestCompletePeriod("2026-10-20", "month", "2026-10-28")?.label).toBe("Sep 2026");
    expect(latestCompletePeriod("2028-05-01", "year", "2026-10-28")?.label).toBe("2025");
    expect(latestCompletePeriod("2024-12-30", "year", "invalid")).toBeNull();
  });

  it("handles quarter and month boundaries, leap years, and year rollover in UTC", () => {
    expect(latestCompletePeriod("2024-04-01", "quarter")).toEqual({ start: "2024-01-01", end: "2024-03-31", label: "Q1 2024", previousLabel: "Q4 2023" });
    expect(latestCompletePeriod("2024-06-30", "quarter")).toEqual({ start: "2024-04-01", end: "2024-06-30", label: "Q2 2024", previousLabel: "Q1 2024" });
    expect(latestCompletePeriod("2024-02-29", "month")).toEqual({ start: "2024-02-01", end: "2024-02-29", label: "Feb 2024", previousLabel: "Jan 2024" });
    expect(latestCompletePeriod("2024-02-28", "month")?.label).toBe("Jan 2024");
    expect(latestCompletePeriod("2023-02-28", "month")?.end).toBe("2023-02-28");
    expect(latestCompletePeriod("2024-01-01T00:00:00.000Z", "month")).toEqual({ start: "2023-12-01", end: "2023-12-31", label: "Dec 2023", previousLabel: "Nov 2023" });
    expect(latestCompletePeriod("2100-02-28", "month")?.end).toBe("2100-02-28");
    expect(latestCompletePeriod("2000-02-29", "month")?.end).toBe("2000-02-29");
  });

  it("rejects invalid dates and periods whose previous date range is outside SQL Server's date domain", () => {
    for (const date of ["", "invalid", "2024-02-30", "2023-02-29", "2024-00-15", "2024-13-01", "0000-12-31", "10000-01-01", "2024-1-1"]) expect(latestCompletePeriod(date, "year")).toBeNull();
    expect(latestCompletePeriod("0001-12-31", "year")).toBeNull();
    expect(latestCompletePeriod("0002-12-31", "year")?.label).toBe("2");
    expect(latestCompletePeriod("9999-12-31", "year")?.end).toBe("9999-12-31");
  });

  it("creates inclusive canonical date filters without modifying its inputs", () => {
    const attribute = { table: "calendar", column: "date" };
    const period = latestCompletePeriod("2024-12-31", "year")!;
    expect(periodFilters(attribute, period)).toEqual([
      { attribute, op: "gte", value: "2024-01-01" },
      { attribute, op: "lte", value: "2024-12-31" },
    ]);
    expect(attribute).toEqual({ table: "calendar", column: "date" });
  });
});

describe("comparison period metadata", () => {
  it("resolves the real date attribute and follows nested or renamed YoY expressions", () => {
    expect(kpiDateAttribute(model)).toEqual({ table: model.date!.tableId, column: model.date!.dateColumnId });
    expect(comparisonPeriodType(model, "Sales YoY %")).toBe("year");
    const renamed = structuredClone(model);
    const yoy = renamed.measures.find((entry) => entry.name === "Sales YoY %")!;
    yoy.name = "Revenue growth";
    expect(comparisonPeriodType(renamed, yoy.id)).toBe("year");
    expect(comparisonPeriodType(model, "Sales")).toBeNull();
  });

  it("recognizes quarter/month previous-period comparisons and refuses mixed offsets", () => {
    const add = (name: string, expression: string) => ({ ...model.measures[0], id: name, name, expression });
    const copy = { ...model, measures: [...model.measures,
      add("Quarter change", "DIVIDE([Sales] - PREVIOUSPERIOD([Sales], QUARTER), PREVIOUSPERIOD([Sales], QUARTER))"),
      add("Month change", "DIVIDE([Sales] - PREVIOUSPERIOD([Sales], MONTH), PREVIOUSPERIOD([Sales], MONTH))"),
      add("Mixed change", "PREVIOUSPERIOD([Sales], MONTH) + SAMEPERIODLASTYEAR([Sales])"),
    ] };
    expect(comparisonPeriodType(copy, "Quarter change")).toBe("quarter");
    expect(comparisonPeriodType(copy, "Month change")).toBe("month");
    expect(comparisonPeriodType(copy, "Mixed change")).toBeNull();
    expect(comparisonPeriodType(copy, "missing")).toBeNull();
  });

  it("hides time comparisons when a model has no valid date dimension", () => {
    const withoutDate = { ...model, date: undefined };
    expect(kpiDateAttribute(withoutDate)).toBeNull();
    expect(comparisonPeriodType(withoutDate, "Sales YoY %")).toBeNull();
    expect(kpiDateAttribute({ ...model, date: { ...model.date!, dateColumnId: "missing" } })).toBeNull();
  });
});

describe("Superstore period regression arithmetic", () => {
  it("uses a single full year's totals for the reported 2024 vs 2023 +12.53% case", () => {
    // Explicit regression fixture for the reported percentage. The repository CSV
    // is a different Superstore sample (2024–2026) and contains no 2023 rows.
    const rows = [
      { date: "2023-01-01", sales: 40_000 }, { date: "2023-12-31", sales: 60_000 },
      { date: "2024-01-01", sales: 50_000 }, { date: "2024-12-30", sales: 62_530 },
    ];
    const period = latestCompletePeriod(rows.at(-1)!.date, "year", "2026-10-28")!;
    const current = rows.filter((row) => row.date >= period.start && row.date <= period.end).reduce((sum, row) => sum + row.sales, 0);
    const previous = rows.filter((row) => row.date.startsWith(period.previousLabel)).reduce((sum, row) => sum + row.sales, 0);
    const change = (current - previous) / previous;
    expect(current).toBe(112_530);
    expect(change).toBeCloseTo(0.1253, 12);
    expect(`${period.label} vs ${period.previousLabel} +${formatMeasure(change, "percent")}`).toBe("2024 vs 2023 +12.53%");
    expect(rows.reduce((sum, row) => sum + row.sales, 0)).toBe(212_530);
  });

  it("uses the checked-in CSV's actual latest complete year, not its incomplete 2026 range", () => {
    const rows = readSuperstoreRows();
    const latest = rows.map((row) => row.date).sort().at(-1)!;
    expect(latest).toBe("2026-09-26");
    const period = latestCompletePeriod(latest, "year", "2026-10-28")!;
    expect(period).toEqual({ start: "2025-01-01", end: "2025-12-31", label: "2025", previousLabel: "2024" });
    const total = (year: string) => rows.filter((row) => row.date.startsWith(year)).reduce((sum, row) => sum + (row.sales ?? 0), 0);
    expect(total(period.label)).toBeCloseTo(525_227.04, 2);
    expect(total(period.previousLabel)).toBeCloseTo(572_592.29, 2);
    expect(formatMeasure((total(period.label) - total(period.previousLabel)) / total(period.previousLabel), "percent")).toBe("-8.27%");
  });
});
