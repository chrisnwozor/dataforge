export type ProjectStatus = "Ready" | "Needs review" | "Draft" | "Processing";
export interface Project {
  id: string;
  name: string;
  description: string;
  sourceName: string;
  sourceType: "CSV" | "XLSX";
  status: ProjectStatus;
  lastRun: string;
  rows: number;
  columns: number;
  tables: number;
  updatedAt: string;
  activity: number[];
  stage: number;
  duplicateRows?: number | null;
  totalNullCells?: number | null;
}
export type ColumnType = "VARCHAR" | "INT" | "DECIMAL" | "DATE" | "BOOLEAN";
export interface ColumnProfile {
  ordinal?: number;
  inferredType?: ColumnType;
  overrideType?: ColumnType | null;
  sampleValues?: string[];
  id: string;
  name: string;
  type: ColumnType;
  nullPercent: number;
  distinct: number;
  duplicates: number;
  min: string;
  max: string;
  keyCandidate: boolean;
  nearKeyCandidate?: boolean;
  nullCount?: number;
}
export interface FactTable {
  name: string;
  grain: string;
  columnIds: string[];
}
export interface Dimension {
  id: string;
  name: string;
  columnIds: string[];
  businessKey: string;
}
export interface Model {
  fact: FactTable;
  dimensions: Dimension[];
  unassigned: string[];
}
export interface Run {
  id: string;
  status: "Success" | "Failed" | "Running";
  started: string;
  duration: string;
  rowsLoaded: number;
  rowsRejected: number;
  logs: {
    time: string;
    level: "INFO" | "SUCCESS" | "ERROR";
    message: string;
  }[];
  rejected: { row: number; column: string; value: string; reason: string }[];
}
export interface GeneratedFile {
  name: string;
  content: string;
}
export interface Activity {
  title: string;
  description: string;
  time: string;
  kind: "upload" | "profile" | "model" | "run";
}
