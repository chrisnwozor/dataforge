import type { QueryResult, QueryValue } from "@/lib/semantic/query/types";

/** Strings that spreadsheet software treats as formulas are prefixed, never evaluated. */
export function csvCell(value: QueryValue | undefined): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  if (typeof value === "string" && /^[\s\uFEFF]*[=+\-@\t\r]/u.test(value)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultToCsv(result: Pick<QueryResult, "columns" | "rows">): string {
  const records = [result.columns.map((column) => csvCell(column.name)).join(",")];
  for (const row of result.rows.slice(0, 50_000)) records.push(result.columns.map((column) => csvCell(row[column.key])).join(","));
  return `\uFEFF${records.join("\r\n")}\r\n`;
}
