import type { InferredType, ProfileColumn } from "@/lib/profiler/types";
import type {
  Model,
  Measure,
  Dimension,
  ForeignKey,
  DegenerateDimension,
} from "@/lib/modeling/types";

export interface GeneratedFile {
  name: string;
  description: string;
  sql: string;
}

export interface SqlColumn extends ProfileColumn {
  overrideType: InferredType | null;
  maxLength: number;
  maxDecimalPlaces: number;
}

export interface GenerationOptions {
  incremental: boolean;
  dedupe: boolean;
  database: string;
  generatedAt: string;
}

export interface SqlGenerationInput {
  project: {
    id: string;
    name: string;
    sourceFile: string;
    sourceType: "CSV" | "XLSX";
  };
  columns: SqlColumn[];
  model: Model;
  options: GenerationOptions;
}

export interface PreparedColumn {
  id: string;
  name: string;
  type: string;
  source: SqlColumn;
}
export interface PreparedDimension {
  model: Dimension;
  table: string;
  key: string;
  columns: PreparedColumn[];
  businessKey: PreparedColumn | null;
}
export interface PreparedForeignKey {
  model: ForeignKey;
  name: string;
  dimension: PreparedDimension;
  source: SqlColumn | null;
}
export interface SqlContext {
  input: SqlGenerationInput;
  stageTable: string;
  stageImportView: string;
  factTable: string;
  factKey: string;
  stageColumns: Map<string, string>;
  columns: Map<string, SqlColumn>;
  dimensions: PreparedDimension[];
  foreignKeys: PreparedForeignKey[];
  measures: (PreparedColumn & { model: Measure })[];
  degenerates: (PreparedColumn & { model: DegenerateDimension })[];
  dateColumns: SqlColumn[];
}
