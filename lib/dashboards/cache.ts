import type { ViewConfig } from "@/lib/explore/config";
import type { QueryFilter } from "@/lib/semantic/query/types";
import type { DashboardTile } from "./schema";

export interface TileCacheKeyInput {
  projectId: string;
  modelVersion: string;
  lastSuccessfulRunId: string | null;
  tile: DashboardTile;
  filters: readonly QueryFilter[];
  viewConfig?: ViewConfig | null;
}

/** Stable JSON without depending on server state or browser APIs. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
}

export function tileCacheKey({ projectId, modelVersion, lastSuccessfulRunId, tile, filters, viewConfig }: TileCacheKeyInput): string {
  // Moving a tile changes its presentation, not the data it reads.
  const config = Object.fromEntries(Object.entries(tile).filter(([key]) => !["x", "y", "w", "h"].includes(key)));
  const normalizedFilters = filters.map((filter) => ({
    ...filter,
    ...(filter.values ? { values: [...filter.values].sort((a, b) => stable(a).localeCompare(stable(b))) } : {}),
  })).sort((a, b) => stable(a).localeCompare(stable(b)));
  return `dashboard-tile-v1:${stable({ projectId, modelVersion, lastSuccessfulRunId, tile: config, viewConfig, filters: normalizedFilters })}`;
}
