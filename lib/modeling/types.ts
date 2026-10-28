import type { InferredType } from "@/lib/profiler/types";

export type Aggregation = "SUM" | "AVG" | "COUNT" | "MIN" | "MAX";

export interface Measure {
  columnId: string;
  name: string;
  aggregation: Aggregation;
  additivity: "additive" | "non-additive";
  reason: string;
}

export interface ForeignKey {
  name: string;
  dimensionId: string;
  sourceColumnId: string | null;
  reason: string;
}

export interface DegenerateDimension {
  columnId: string;
  name: string;
  reason: string;
}

export interface Dimension {
  id: string;
  name: string;
  businessKey: string;
  columnIds: string[];
  attributes: string[];
  generated: "date" | null;
  reason: string;
}

export interface Model {
  fact: {
    name: string;
    grain: string;
    reason: string;
    measures: Measure[];
    foreignKeys: ForeignKey[];
    degenerateDimensions: DegenerateDimension[];
  };
  dimensions: Dimension[];
  unassigned: string[];
  columnNames: Record<string, string>;
  reasons: Record<string, string>;
  removeExactDuplicates: boolean;
  warnings: string[];
}

export interface SuggestionColumn {
  id: string;
  ordinal: number;
  name: string;
  type: InferredType;
  distinctCount: number;
  nullPct: number;
  isKeyCandidate: boolean;
  isNearKeyCandidate: boolean;
}

export interface SuggestionInput {
  columns: SuggestionColumn[];
  sampledRows: (string | null)[][];
  rowCount: number;
  duplicateRowCount: number;
  topic: string;
}

export interface ModelValidationIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
}
