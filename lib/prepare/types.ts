import type { Cell, PrepareRow } from "./schema";
export type { Cell, PipelineDefinition, PrepareRow, PrepareStep, PrepareCondition, PrepareType, QualityRule } from "./schema";
export interface EngineSource { id: string; columns: string[]; open(options?: { limit?: number; signal?: AbortSignal }): AsyncIterable<PrepareRow> }
export interface RuleSummary { id: string; name: string; severity: "reject" | "warn" | "fail"; checked: number; failed: number; ratePct: number }
export interface StepSummary { id: string; name: string; type: string; rowsIn: number; rowsOut: number; rowsRejected: number; removed: number; ruleCounts: RuleSummary[] }
export interface PipelineSummary { rowsRead: number; rowsOut: number; rowsRejected: number; steps: StepSummary[]; rules: RuleSummary[]; warnings: string[] }
export interface PrepareReject { stepId: string; stepName: string; ruleName: string; bucket?: string; rowNumber: number; values: PrepareRow }
export interface EngineOptions { signal?: AbortSignal; sourceLimit?: number; maxOutputRows?: number; stopAfterStep?: number; onReject?: (reject: PrepareReject) => void | Promise<void>; onProgress?: (summary: PipelineSummary) => void | Promise<void> }
export interface PipelineExecution { rows: AsyncIterable<PrepareRow>; columns: string[]; summary: PipelineSummary; close(): Promise<void> }
export interface ColumnLineage { column: string; sources: { sourceId: string; column: string }[]; steps: { id: string; name: string; type: string }[] }
export interface PipelineValidation { valid: boolean; errors: { stepId?: string; message: string }[]; columns: string[]; lineage: ColumnLineage[] }
export interface PreparedPreview { before: PrepareRow[]; after: PrepareRow[]; beforeColumns: string[]; afterColumns: string[]; changedColumns: string[]; summary: PipelineSummary; version: number; sampled: boolean }
export type CellTransform = (value: Cell, row: PrepareRow) => Cell;
