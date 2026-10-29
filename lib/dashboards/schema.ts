import { z } from "zod";
import { viewConfigSchema } from "@/lib/explore/config";
import { attributeRefSchema, queryFilterSchema } from "@/lib/semantic/query/schema";

export const GRID_COLUMNS = 12;
export const MIN_TILE_HEIGHT = 2;
export const MAX_TILE_HEIGHT = 24;
export const MAX_GRID_ROWS = 10_000;
export const MAX_DASHBOARD_TILES = 60;

const tileId = z.string().min(1).max(128);
const reference = z.string().min(1).max(256);
export const tileNumberFormatSchema = z.enum(["auto", "number", "currency", "percent", "decimals"]);
const tileBase = z.object({
  id: tileId,
  x: z.number().int().min(0).max(GRID_COLUMNS - 1),
  y: z.number().int().min(0).max(MAX_GRID_ROWS - MIN_TILE_HEIGHT),
  w: z.number().int().min(1).max(GRID_COLUMNS),
  h: z.number().int().min(MIN_TILE_HEIGHT).max(MAX_TILE_HEIGHT),
  title: z.string().max(200).default(""),
  subtitle: z.string().max(500).default(""),
  numberFormat: tileNumberFormatSchema.default("auto"),
  showLegend: z.boolean().default(true),
}).strict();

export const chartSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), viewId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("inline"), config: viewConfigSchema }).strict(),
]);
export const chartTileSchema = tileBase.extend({ type: z.literal("chart"), source: chartSourceSchema });
export const kpiTileSchema = tileBase.extend({ type: z.literal("kpi"), measure: reference, comparisonMeasure: reference.optional() });
export const textTileSchema = tileBase.extend({ type: z.literal("text"), content: z.string().max(20_000) });
export const slicerTileSchema = tileBase.extend({ type: z.literal("slicer"), attribute: attributeRefSchema });
export const dashboardTileSchema = z.discriminatedUnion("type", [chartTileSchema, kpiTileSchema, textTileSchema, slicerTileSchema]);

export type ChartTile = z.infer<typeof chartTileSchema>;
export type KpiTile = z.infer<typeof kpiTileSchema>;
export type TextTile = z.infer<typeof textTileSchema>;
export type SlicerTile = z.infer<typeof slicerTileSchema>;
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

/** Edges may touch; intersecting grid areas are invalid persisted layouts. */
export function tilesOverlap(left: Pick<DashboardTile, "x" | "y" | "w" | "h">, right: Pick<DashboardTile, "x" | "y" | "w" | "h">): boolean {
  return left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y;
}

export const dashboardLayoutSchema = z.object({
  version: z.literal(1),
  tiles: z.array(dashboardTileSchema).max(MAX_DASHBOARD_TILES),
}).strict().superRefine(({ tiles }, context) => {
  const seen = new Set<string>();
  tiles.forEach((tile, index) => {
    if (seen.has(tile.id)) context.addIssue({ code: "custom", path: ["tiles", index, "id"], message: "Each dashboard tile must have a unique ID." });
    seen.add(tile.id);
    if (tile.x + tile.w > GRID_COLUMNS || tile.y + tile.h > MAX_GRID_ROWS)
      context.addIssue({ code: "custom", path: ["tiles", index], message: "Keep the tile inside the dashboard grid." });
    for (let previous = 0; previous < index; previous++)
      if (tilesOverlap(tile, tiles[previous])) {
        context.addIssue({ code: "custom", path: ["tiles", index], message: "Dashboard tiles cannot overlap." });
        break;
      }
  });
});
export const dashboardFiltersSchema = z.object({ version: z.literal(1), items: z.array(queryFilterSchema).max(64) }).strict();
export const dashboardSettingsSchema = z.object({
  version: z.literal(1),
  crossFiltering: z.boolean().default(false),
  autoRefreshMinutes: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(15)]).default(0),
}).strict();
export const dashboardDocumentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  layout: dashboardLayoutSchema,
  filters: dashboardFiltersSchema,
  settings: dashboardSettingsSchema,
}).strict();
export const savedDashboardSchema = dashboardDocumentSchema.extend({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;
export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;
export type DashboardDocument = z.infer<typeof dashboardDocumentSchema>;
export type SavedDashboard = z.infer<typeof savedDashboardSchema>;

export function createEmptyDashboard(name = "Untitled dashboard"): DashboardDocument {
  return dashboardDocumentSchema.parse({
    name, description: "", layout: { version: 1, tiles: [] }, filters: { version: 1, items: [] },
    settings: { version: 1, crossFiltering: false, autoRefreshMinutes: 0 },
  });
}
