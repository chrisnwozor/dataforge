import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

export type SuperstoreAxis = "Year" | "Month" | "Product" | "Category";
export interface SuperstoreRow {
  orderId: string | null;
  date: string;
  year: number;
  month: number;
  product: string;
  category: string;
  sales: number | null;
  profit: number | null;
  raw: string[];
}
export type ExpectedSuperstoreResult = Record<string, string | number | null>;
const nullable = (value: string): number | null =>
  value.trim() ? Number(value) : null;

export function readSuperstoreRows(): SuperstoreRow[] {
  const [, ...rows] = parse(
    readFileSync(join(process.cwd(), "samples/superstore_sales.csv")),
    { skip_empty_lines: true },
  ) as string[][];
  return rows.map((raw) => ({
    orderId: raw[0].trim() || null,
    date: raw[1],
    year: Number(raw[1].slice(0, 4)),
    month: Number(raw[1].slice(5, 7)),
    product: raw[5],
    category: raw[6],
    sales: nullable(raw[7]),
    profit: nullable(raw[10]),
    raw,
  }));
}
const axisValue = (
  row: SuperstoreRow,
  axis: SuperstoreAxis,
): string | number =>
  axis === "Year"
    ? row.year
    : axis === "Month"
      ? row.month
      : axis === "Product"
        ? row.product
        : row.category;
const sum = (
  rows: SuperstoreRow[],
  field: "sales" | "profit",
): number | null => {
  const values = rows
    .map((row) => row[field])
    .filter((value): value is number => value !== null);
  return values.length
    ? values.reduce((total, value) => total + value, 0)
    : null;
};
const divide = (numerator: number | null, denominator: number | null) =>
  numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator;
const dateString = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
export function previousYear(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const finalDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return dateString(year - 1, month, Math.min(day, finalDay));
}

/** Independent row arithmetic: this does not inspect or execute compiler output. */
export function expectedSuperstoreResults(
  observations: SuperstoreRow[],
  axes: readonly SuperstoreAxis[],
): ExpectedSuperstoreResult[] {
  const groups = new Map<string, SuperstoreRow[]>();
  for (const row of observations) {
    const key = JSON.stringify(axes.map((axis) => axisValue(row, axis)));
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  return [...groups.values()]
    .map((rows): ExpectedSuperstoreResult => {
      const first = rows[0];
      const same = (row: SuperstoreRow, ignored: readonly SuperstoreAxis[]) =>
        axes.every(
          (axis) =>
            ignored.includes(axis) ||
            axisValue(row, axis) === axisValue(first, axis),
        );
      const scope = (ignored: readonly SuperstoreAxis[]) =>
        observations.filter((row) => same(row, ignored));
      const dates = rows.map((row) => row.date).sort();
      const lower = dates[0],
        upper = dates.at(-1)!;
      // Date intelligence clears calendar grouping, while preserving other axes.
      const nonDate = observations.filter((row) =>
        same(row, ["Year", "Month"]),
      );
      const ytdStart = upper.slice(0, 4) + "-01-01";
      const ytd = sum(
        nonDate.filter((row) => row.date >= ytdStart && row.date <= upper),
        "sales",
      );
      const lyStart = previousYear(lower),
        lyEnd = previousYear(upper);
      const ly = sum(
        nonDate.filter((row) => row.date >= lyStart && row.date <= lyEnd),
        "sales",
      );
      const sales = sum(rows, "sales");
      const profit = sum(rows, "profit");
      return {
        ...Object.fromEntries(
          axes.map((axis) => [axis, axisValue(first, axis)]),
        ),
        Sales: sales,
        "Profit Margin %": divide(profit, sales),
        "Avg Order Value": divide(
          sales,
          new Set(
            rows.map((row) => row.orderId).filter((value) => value !== null),
          ).size,
        ),
        "Sales % of Total": divide(sales, sum(scope(["Category"]), "sales")),
        "Sales % of Category": divide(sales, sum(scope(["Product"]), "sales")),
        "Sales % of Grand Total": divide(
          sales,
          sum(scope(["Product", "Category"]), "sales"),
        ),
        "Sales % of All Years": divide(sales, sum(scope(["Year"]), "sales")),
        "Sales % of Calendar Grand Total": divide(
          sales,
          sum(scope(["Year", "Month"]), "sales"),
        ),
        "Sales YTD": ytd,
        "Sales LY": ly,
        "Sales YoY %": divide(
          sales === null || ly === null ? null : sales - ly,
          ly,
        ),
      };
    })
    .sort((a, b) => {
      for (const axis of axes) {
        if (a[axis] === b[axis]) continue;
        return typeof a[axis] === "number" && typeof b[axis] === "number"
          ? Number(a[axis]) - Number(b[axis])
          : String(a[axis]).localeCompare(String(b[axis]), "en-US");
      }
      return 0;
    });
}
