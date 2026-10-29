import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
/** User-supplied acceptance constants. Never replace them with fixture-derived values. */
export const SUPERSTORE_ACCEPTANCE = {
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
  years: { "2022": 655111.95, "2023": 583648.73, "2024": 656764.29 },
  yoy2024Percent: 12.53,
} as const;
export interface SuperstoreOracle {
  rows: number;
  uniqueRows: number;
  duplicates: number;
  sales: number;
  profit: number;
  categories: Record<string, number>;
  years: Record<string, number>;
  yoy2024Percent: number | null;
}
function cents(value: string): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error(
      "The Superstore acceptance oracle expects decimal money with at most two places.",
    );
  const negative = value.startsWith("-"),
    parts = value.replace(/^[-+]/, "").split(".");
  return (
    (negative ? -1 : 1) *
    (Number(parts[0]) * 100 + Number((parts[1] ?? "").padEnd(2, "0")))
  );
}
export async function readSuperstoreOracle(
  filePath: string,
): Promise<SuperstoreOracle> {
  const source = createReadStream(/* turbopackIgnore: true */ filePath),
    parser = source.pipe(
      parse({ columns: true, bom: true, skip_empty_lines: true }),
    );
  let rows = 0,
    sales = 0,
    profit = 0;
  const seen = new Set<string>(),
    categories: Record<string, number> = {},
    years: Record<string, number> = {};
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      rows++;
      const key = JSON.stringify(Object.entries(row));
      if (seen.has(key)) continue;
      seen.add(key);
      const sale = cents(row.Sales),
        gain = cents(row.Profit),
        year = row["Order Date"].slice(0, 4);
      sales += sale;
      profit += gain;
      categories[row.Category] = (categories[row.Category] ?? 0) + sale;
      years[year] = (years[year] ?? 0) + sale;
    }
  } finally {
    source.destroy();
    parser.destroy();
  }
  return {
    rows,
    uniqueRows: seen.size,
    duplicates: rows - seen.size,
    sales: sales / 100,
    profit: profit / 100,
    categories: Object.fromEntries(
      Object.entries(categories).map(([k, v]) => [k, v / 100]),
    ),
    years: Object.fromEntries(
      Object.entries(years).map(([k, v]) => [k, v / 100]),
    ),
    yoy2024Percent: years["2023"]
      ? Math.round(
          (((years["2024"] ?? 0) - years["2023"]) / years["2023"]) * 10000,
        ) / 100
      : null,
  };
}
export function superstoreAcceptanceDifferences(
  actual: SuperstoreOracle,
): string[] {
  const e = SUPERSTORE_ACCEPTANCE,
    issues: string[] = [];
  const compare = (
    name: string,
    expected: number,
    found: number | null | undefined,
  ) => {
    if (
      found === null ||
      found === undefined ||
      Math.abs(expected - found) > 0.01
    )
      issues.push(
        `${name}: expected ${expected}, actual ${found ?? "missing"}`,
      );
  };
  compare("unique rows", e.loaded, actual.uniqueRows);
  compare("Sales", e.sales, actual.sales);
  compare("Profit", e.profit, actual.profit);
  for (const [k, v] of Object.entries(e.categories))
    compare(`Category ${k}`, v, actual.categories[k]);
  for (const [k, v] of Object.entries(e.years))
    compare(`Year ${k}`, v, actual.years[k]);
  compare("YoY 2024 vs 2023 (%)", e.yoy2024Percent, actual.yoy2024Percent);
  return issues;
}
