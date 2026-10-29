import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  SUPERSTORE_ACCEPTANCE,
  readSuperstoreOracle,
  superstoreAcceptanceDifferences,
} from "@/lib/verify/superstore";
describe("Superstore acceptance values remain independent from the checked-in data", () => {
  it("retains the requested constants verbatim", () => {
    expect(SUPERSTORE_ACCEPTANCE).toEqual({
      staged: 2003,
      loaded: 2000,
      rejects: 0,
      sales: 1895524.97,
      profit: 187453.06,
      categories: {
        Furniture: 1214651.07,
        "Office Supplies": 107597.24,
        Technology: 573276.66,
      },
      years: { 2022: 655111.95, 2023: 583648.73, 2024: 656764.29 },
      yoy2024Percent: 12.53,
    });
  });
  it("reports the actual sample discrepancy instead of changing its input or expected values", async () => {
    const actual = await readSuperstoreOracle(
      join(process.cwd(), "samples/superstore_sales.csv"),
    );
    expect(actual).toMatchObject({
      rows: 2000,
      uniqueRows: 2000,
      duplicates: 0,
      sales: 1485523.86,
      profit: 208556.86,
      categories: {
        Furniture: 888364.6,
        "Office Supplies": 59734.86,
        Technology: 537424.4,
      },
      years: { 2024: 572592.29, 2025: 525227.04, 2026: 387704.53 },
      yoy2024Percent: null,
    });
    const issues = superstoreAcceptanceDifferences(actual);
    expect(issues).toContain("Sales: expected 1895524.97, actual 1485523.86");
    expect(issues).toContain("Year 2022: expected 655111.95, actual missing");
    expect(issues.length).toBeGreaterThan(5);
  });
});
