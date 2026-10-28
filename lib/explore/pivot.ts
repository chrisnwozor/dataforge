import type { QueryResult, QueryResultColumn, QueryValue } from "@/lib/semantic/query/types";
import type { ViewConfig } from "./config";

export interface PivotTotals { rows?: QueryResult; columns?: QueryResult; grand?: QueryResult }
export interface PivotColumn { key: string; members: QueryValue[] }
export interface PivotRow {
  key: string;
  members: QueryValue[];
  values: Record<string, QueryValue[]>;
  total: QueryValue[];
}
export interface PivotResult {
  rows: PivotRow[];
  columns: PivotColumn[];
  measureColumns: QueryResultColumn[];
  columnTotals: Record<string, QueryValue[]>;
  grandTotal: QueryValue[];
  truncatedColumns: boolean;
  totalColumnMembers: number;
}

export const pivotMemberKey = (values: QueryValue[]): string => JSON.stringify(values);
const valuesFor = (record: Record<string, QueryValue>, keys: string[]) => keys.map((key) => record[key] ?? null);

/** Reshape already aggregated long data; totals always come from their own server context. */
export function buildPivot(result: QueryResult, config: Pick<ViewConfig, "rows" | "columns">, totals: PivotTotals = {}): PivotResult {
  const attributes = result.columns.filter((column) => column.role === "attribute");
  const rowKeys = result.pivot?.rowKeys ?? attributes.slice(0, config.rows.length).map((column) => column.key);
  const columnKeys = result.pivot?.columnKeys ?? attributes.slice(config.rows.length, config.rows.length + config.columns.length).map((column) => column.key);
  const measureColumns = result.columns.filter((column) => column.role === "measure");
  const measureKeys = measureColumns.map((column) => column.key);
  const allColumns = new Map<string, PivotColumn>();
  const columns = new Map<string, PivotColumn>();
  const rowMap = new Map<string, PivotRow>();
  const emptyMeasures = (): QueryValue[] => measureColumns.map(() => null);
  for (const record of result.rows) {
    const members = valuesFor(record, columnKeys);
    const columnKey = pivotMemberKey(members);
    if (!allColumns.has(columnKey)) allColumns.set(columnKey, { key: columnKey, members });
    if (!columns.has(columnKey) && columns.size < 50) columns.set(columnKey, { key: columnKey, members });
    const rowMembers = valuesFor(record, rowKeys);
    const rowKey = pivotMemberKey(rowMembers);
    let row = rowMap.get(rowKey);
    if (!row) {
      row = { key: rowKey, members: rowMembers, values: Object.create(null) as Record<string, QueryValue[]>, total: emptyMeasures() };
      rowMap.set(rowKey, row);
    }
    if (columns.has(columnKey)) row.values[columnKey] = valuesFor(record, measureKeys);
  }
  const readTotals = (source: QueryResult | undefined): Map<string, QueryValue[]> => {
    const map = new Map<string, QueryValue[]>();
    if (!source || source.truncated) return map;
    const keys = source.columns.filter((column) => column.role === "attribute").map((column) => column.key);
    // Aliases change when grouping columns are removed, so align measures by name.
    const sourceMeasures = measureColumns.map((column) => source.columns.find((item) => item.role === "measure" && item.name === column.name)?.key);
    for (const record of source.rows)
      map.set(pivotMemberKey(valuesFor(record, keys)), sourceMeasures.map((key) => key ? record[key] ?? null : null));
    return map;
  };
  const rowTotals = readTotals(totals.rows);
  const columnTotals = readTotals(totals.columns);
  const grand = readTotals(totals.grand).get("[]") ?? emptyMeasures();
  for (const row of rowMap.values()) row.total = rowTotals.get(row.key) ?? emptyMeasures();
  const visibleColumnTotals: Record<string, QueryValue[]> = Object.create(null) as Record<string, QueryValue[]>;
  for (const key of columns.keys()) visibleColumnTotals[key] = columnTotals.get(key) ?? emptyMeasures();
  // The query API also caps the domain before returning rows. Its truncation bit
  // cannot distinguish that cap from its row limit; retain the warning honestly.
  const serverColumnLimit = Boolean(result.pivot && result.truncated && config.columns.length && columns.size >= 50);
  return { rows: [...rowMap.values()], columns: [...columns.values()], measureColumns, columnTotals: visibleColumnTotals, grandTotal: grand, truncatedColumns: allColumns.size > 50 || serverColumnLimit, totalColumnMembers: allColumns.size };
}
