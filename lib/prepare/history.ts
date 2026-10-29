import { pipelineDefinitionSchema, type PipelineDefinition } from "./schema";
export interface PipelineHistory { past: PipelineDefinition[]; present: PipelineDefinition; future: PipelineDefinition[] }
export type PipelineHistoryAction = { type: "set" | "reset"; definition: PipelineDefinition } | { type: "undo" | "redo" };
export function createPipelineHistory(definition: PipelineDefinition): PipelineHistory { return { past: [], present: structuredClone(pipelineDefinitionSchema.parse(definition)), future: [] }; }
export function pipelineHistoryReducer(state: PipelineHistory, action: PipelineHistoryAction): PipelineHistory {
  if (action.type === "reset") return createPipelineHistory(action.definition);
  if (action.type === "undo") return state.past.length ? { past: state.past.slice(0, -1), present: state.past.at(-1)!, future: [state.present, ...state.future] } : state;
  if (action.type === "redo") return state.future.length ? { past: [...state.past, state.present].slice(-50), present: state.future[0], future: state.future.slice(1) } : state;
  if (!("definition" in action)) return state;
  const definition = pipelineDefinitionSchema.parse(action.definition);
  return JSON.stringify(definition) === JSON.stringify(state.present) ? state : { past: [...state.past, state.present].slice(-50), present: structuredClone(definition), future: [] };
}
