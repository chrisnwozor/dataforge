import { dashboardDocumentSchema, type DashboardDocument } from "./schema";

export const DASHBOARD_HISTORY_LIMIT = 50;
export interface DashboardHistory {
  past: DashboardDocument[];
  present: DashboardDocument;
  future: DashboardDocument[];
}
export type DashboardHistoryAction =
  | { type: "set"; document: DashboardDocument }
  | { type: "reset"; document: DashboardDocument }
  | { type: "undo" }
  | { type: "redo" };

export function createDashboardHistory(document: DashboardDocument): DashboardHistory {
  return { past: [], present: dashboardDocumentSchema.parse(document), future: [] };
}

/** Autosave state lives outside history: editing and undoing are both saveable documents. */
export function dashboardHistoryReducer(state: DashboardHistory, action: DashboardHistoryAction): DashboardHistory {
  if (action.type === "reset") return createDashboardHistory(action.document);
  if (action.type === "set") {
    const next = dashboardDocumentSchema.parse(action.document);
    if (JSON.stringify(next) === JSON.stringify(state.present)) return state;
    return { past: [...state.past, state.present].slice(-DASHBOARD_HISTORY_LIMIT), present: next, future: [] };
  }
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    return previous ? { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future].slice(0, DASHBOARD_HISTORY_LIMIT) } : state;
  }
  const next = state.future[0];
  return next ? { past: [...state.past, state.present].slice(-DASHBOARD_HISTORY_LIMIT), present: next, future: state.future.slice(1) } : state;
}
