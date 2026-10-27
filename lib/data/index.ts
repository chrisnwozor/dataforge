import type { Project, ColumnProfile, Activity } from "@/lib/types";
import type { InferredType } from "@/lib/profiler";
import {
  listProjects,
  findProject,
  readColumnProfiles,
  readProfileReport,
  type StoredProject,
} from "@/lib/server/projects";

export {
  getSuggestedModel,
  getInitialModel,
  getRuns,
  getGeneratedFiles,
} from "./mock";

const uiType: Record<InferredType, ColumnProfile["type"]> = {
  integer: "INT",
  decimal: "DECIMAL",
  date: "DATE",
  boolean: "BOOLEAN",
  text: "VARCHAR",
};
function relativeTime(timestamp: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(timestamp).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
function toProject(project: StoredProject): Project {
  return {
    id: project.id,
    name: project.name,
    description: `${project.sourceFile} · ${project.rowCount.toLocaleString("en-US")} rows profiled`,
    sourceName: project.sourceFile,
    sourceType: project.sourceType,
    status: project.status,
    rows: project.rowCount,
    columns: project.columnCount,
    updatedAt: relativeTime(project.updatedAt),
    tables: 0,
    lastRun: "Not run yet",
    activity: [],
    stage: 2,
  };
}
export async function getProjects(): Promise<Project[]> {
  return listProjects().map(toProject);
}
export async function getProject(id: string): Promise<Project | undefined> {
  const project = findProject(id);
  return project ? toProject(project) : undefined;
}
export async function getColumnProfiles(id: string): Promise<ColumnProfile[]> {
  return readColumnProfiles(id).map((column) => ({
    id: String(column.ordinal),
    ordinal: column.ordinal,
    name: column.name,
    type: uiType[column.overrideType ?? column.inferredType],
    inferredType: uiType[column.inferredType],
    overrideType: column.overrideType ? uiType[column.overrideType] : null,
    nullPercent: column.nullPct,
    distinct: column.distinctCount,
    duplicates: column.duplicateCount,
    min: column.minValue ?? "—",
    max: column.maxValue ?? "—",
    keyCandidate: column.isKeyCandidate,
    sampleValues: column.sampleValues,
  }));
}
export async function getProfileReport(id: string) {
  return readProfileReport(id);
}
export async function getActivity(id: string): Promise<Activity[]> {
  const project = findProject(id);
  if (!project) return [];
  return [
    {
      title: "Data profile completed",
      description: `${project.columnCount} columns analyzed across ${project.rowCount.toLocaleString("en-US")} rows.`,
      time: relativeTime(project.createdAt),
      kind: "profile",
    },
    {
      title: "Source file uploaded",
      description: project.sourceFile,
      time: relativeTime(project.createdAt),
      kind: "upload",
    },
  ];
}
