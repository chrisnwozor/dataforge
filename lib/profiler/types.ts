export type InferredType = "integer" | "decimal" | "date" | "boolean" | "text";

export interface ProfileColumn {
  ordinal: number;
  name: string;
  inferredType: InferredType;
  nullPct: number;
  nullCount: number;
  distinctCount: number;
  duplicateCount: number;
  minValue: string | null;
  maxValue: string | null;
  isKeyCandidate: boolean;
  isNearKeyCandidate: boolean;
  sampleValues: string[];
}

export interface ProfileResult {
  rowCount: number;
  columnCount: number;
  /** Additional occurrences of fully identical, normalized source rows. */
  duplicateRowCount: number;
  totalNullCells: number;
  /** First source rows, aligned by ordinal, bounded by row and JSON byte budgets. */
  sampledRows: (string | null)[][];
  sampledRowsTruncated: boolean;
  columns: ProfileColumn[];
  raggedRowCount: number;
  raggedRowExamples: { row: number; expected: number; actual: number }[];
  delimiter: string;
}
