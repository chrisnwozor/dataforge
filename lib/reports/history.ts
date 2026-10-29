import { reportDocumentSchema, type ReportDocument } from "./schema";
export const REPORT_HISTORY_LIMIT = 50;
export interface ReportHistory { past: ReportDocument[]; present: ReportDocument; future: ReportDocument[] }
export type ReportHistoryAction = { type: "set" | "reset"; document: ReportDocument } | { type: "undo" | "redo" };
export const createReportHistory = (document: ReportDocument): ReportHistory => ({ past: [], present: reportDocumentSchema.parse(document), future: [] });
export function reportHistoryReducer(state: ReportHistory, action: ReportHistoryAction): ReportHistory {
  if (action.type === "reset") return createReportHistory(action.document);
  if (action.type === "set") {
    const present = reportDocumentSchema.parse(action.document);
    return JSON.stringify(present) === JSON.stringify(state.present) ? state : { past: [...state.past, state.present].slice(-REPORT_HISTORY_LIMIT), present, future: [] };
  }
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future].slice(0, REPORT_HISTORY_LIMIT) } : state;
  }
  const next = state.future[0];
  return next ? { past: [...state.past, state.present].slice(-REPORT_HISTORY_LIMIT), present: next, future: state.future.slice(1) } : state;
}
