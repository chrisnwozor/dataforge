import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  formatAttribute,
  formatMeasure,
  formatValue,
  isIdentifierName,
} from "@/lib/explore/format";
import { StatCard } from "@/components/shared";
import { Button } from "@/components/ui/button";

describe("consistent numeric presentation", () => {
  it("keeps identifier and year digits intact while grouping real measure counts", () => {
    for (const name of [
      "Order ID",
      "CustomerID",
      "ProductKey",
      "region_code",
      "Invoice Number",
      "Year",
    ])
      expect(formatAttribute(123456, { name, type: "number" }), name).toBe(
        "123456",
      );
    expect(
      formatAttribute("000123456", { name: "Product Code", type: "string" }),
    ).toBe("000123456");
    expect(formatAttribute(2024, { name: "Period", type: "number" })).toBe(
      "2024",
    );
    expect(formatMeasure(123456, "number")).toBe("123,456");
    expect(formatMeasure("9007199254740993", "number")).toBe(
      "9,007,199,254,740,993",
    );
    expect(isIdentifierName("Sales")).toBe(false);
  });

  it("reconciles displayed currency, decimals and percentage with independently rounded raw values", () => {
    const cases = [
      {
        value: 1895524.97,
        format: "currency",
        expected: "$1,895,524.97",
        multiplier: 1,
      },
      {
        value: -187453.06,
        format: "currency",
        expected: "-$187,453.06",
        multiplier: 1,
      },
      {
        value: 1200.5,
        format: "decimals",
        expected: "1,200.50",
        multiplier: 1,
      },
      { value: -12.5, format: "decimals", expected: "-12.50", multiplier: 1 },
      { value: 0.1253, format: "percent", expected: "12.53%", multiplier: 100 },
      { value: 0.125, format: "percent", expected: "12.50%", multiplier: 100 },
      {
        value: -0.0827,
        format: "percent",
        expected: "-8.27%",
        multiplier: 100,
      },
    ] as const;
    for (const sample of cases) {
      const displayed = formatMeasure(sample.value, sample.format);
      expect(displayed).toBe(sample.expected);
      const numericText = displayed.replace(/[$,%]/g, "");
      const independentRounded =
        (Math.round(Math.abs(sample.value * sample.multiplier) * 100) / 100) *
        Math.sign(sample.value);
      expect(Number(numericText)).toBeCloseTo(independentRounded, 10);
    }
    expect(formatMeasure(-0, "decimals")).toBe("0.00");
  });

  it("renders absent values consistently and gives their visible dash a full explanation", () => {
    for (const value of [null, undefined, "", NaN, Infinity])
      expect(formatValue(value)).toBe("—");
    const html = renderToStaticMarkup(
      createElement(StatCard, {
        label: "Null cells",
        value: "—",
        detail: "Not yet profiled",
      }),
    );
    expect(html).toContain('title="No value (NULL or unavailable)"');
    expect(html).toContain("—");
  });

  it("makes icon button names available as visible native tooltips", () => {
    const html = renderToStaticMarkup(
      createElement(
        Button,
        { "aria-label": "Open the full result", size: "icon" },
        "+",
      ),
    );
    expect(html).toContain('title="Open the full result"');
    expect(html).toContain('aria-label="Open the full result"');
  });
});
