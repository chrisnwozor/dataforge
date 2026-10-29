import { describe, expect, it } from "vitest";
import { conditionalStyle } from "@/lib/reports/conditional";

describe("report conditional formatting", () => {
  it("matches only the named measure and strict greater/less comparisons", () => {
    const rules = [{ measure: "profit", op: "lt" as const, value: 0, color: "#dd0000", bold: false }, { measure: "profit", op: "gt" as const, value: 100, bold: true }];
    expect(conditionalStyle(-1, "profit", rules)).toEqual({ color: "#dd0000" });
    expect(conditionalStyle(0, "profit", rules)).toEqual({});
    expect(conditionalStyle(100, "profit", rules)).toEqual({});
    expect(conditionalStyle(101, "profit", rules)).toEqual({ bold: true });
    expect(conditionalStyle(-1, "sales", rules)).toEqual({});
  });
  it("accepts driver numeric strings, ignores null/non-numeric values, and merges matching styles in rule order", () => {
    const rules = [{ measure: "m", op: "gt" as const, value: 1, color: "#112233", bold: false }, { measure: "m", op: "gt" as const, value: 2, color: "#445566", bold: true }];
    expect(conditionalStyle("3.50", "m", rules)).toEqual({ color: "#445566", bold: true });
    for (const value of [null, undefined, "", "wrong", true, NaN, Infinity]) expect(conditionalStyle(value, "m", rules)).toEqual({});
  });
});
