export type InferredType = "integer" | "decimal" | "date" | "boolean" | "text";

export interface ProfileColumn {
  ordinal: number;
  name: string;
  inferredType: InferredType;
  nullPct: number;
  distinctCount: number;
  duplicateCount: number;
  minValue: string | null;
  maxValue: string | null;
  isKeyCandidate: boolean;
  sampleValues: string[];
}

export interface ProfileResult {
  rowCount: number;
  columnCount: number;
  columns: ProfileColumn[];
  raggedRowCount: number;
  raggedRowExamples: { row: number; expected: number; actual: number }[];
  delimiter: string;
}
