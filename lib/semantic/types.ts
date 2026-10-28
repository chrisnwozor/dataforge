export type SemanticType = "number" | "string" | "boolean" | "date";
export type MeasureFormat = "number" | "currency" | "percent" | "decimals";
export interface SemanticColumn {
  id: string;
  tableId: string;
  name: string;
  sqlName: string;
  type: SemanticType;
  role: "key" | "attribute" | "measure-source";
  sourceColumnId?: string;
}
export interface SemanticTable {
  id: string;
  name: string;
  schema: string;
  sqlName: string;
  kind: "fact" | "dimension";
  keyColumnId: string;
  columns: SemanticColumn[];
}
export interface SemanticRelationship {
  id: string;
  fromTableId: string;
  fromColumnId: string;
  toTableId: string;
  toColumnId: string;
  cardinality: "many-to-one";
}
export interface SemanticMeasure {
  id: string;
  name: string;
  expression: string;
  format: MeasureFormat;
  folder: string;
  description: string;
  isAuto: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SemanticHierarchy {
  id: string;
  name: string;
  tableId: string;
  levels: string[];
  isAuto: boolean;
}
export interface SemanticModel {
  projectId: string;
  version: string;
  factTableId: string;
  tables: SemanticTable[];
  relationships: SemanticRelationship[];
  measures: SemanticMeasure[];
  hierarchies: SemanticHierarchy[];
  date?: {
    tableId: string;
    dateColumnId: string;
    keyColumnId: string;
    factColumnId: string;
  };
}
export interface SqlParameter {
  name: string;
  value: string | number | boolean | null;
  type?: SemanticType;
}
