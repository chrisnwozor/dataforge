import { describe, expect, it } from "vitest";
import { createEmptyView } from "@/lib/explore/config";
import {
  createEmptyDashboard, dashboardDocumentSchema, dashboardFiltersSchema,
  dashboardLayoutSchema, dashboardSettingsSchema, savedDashboardSchema,
  MAX_GRID_ROWS, type DashboardDocument, type DashboardTile,
} from "@/lib/dashboards/schema";
import { appendTile, keyboardTile, moveTile, normalizeLayout, resizeTile, tilesOverlap } from "@/lib/dashboards/layout";
import { createDashboardHistory, dashboardHistoryReducer, DASHBOARD_HISTORY_LIMIT } from "@/lib/dashboards/history";

const viewId = "11111111-1111-4111-8111-111111111111";
const tile = (id: string, x = 0, y = 0, w = 6, h = 4): DashboardTile => ({
  id, type: "text", x, y, w, h, title: id, subtitle: "", numberFormat: "auto", showLegend: true, content: "Notes",
});
const document = (...tiles: DashboardTile[]): DashboardDocument => ({ ...createEmptyDashboard("Sales overview"), layout: { version: 1, tiles } });
const positions = (tiles: DashboardTile[]) => tiles.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }));
const valid = (tiles: DashboardTile[]) => {
  expect(dashboardLayoutSchema.safeParse({ version: 1, tiles }).success).toBe(true);
  for (let index = 0; index < tiles.length; index++)
    for (let other = index + 1; other < tiles.length; other++) expect(tilesOverlap(tiles[index], tiles[other])).toBe(false);
};

describe("versioned dashboard documents", () => {
  it("has explicit versioned defaults without enabling cross-filtering or refresh", () => {
    expect(createEmptyDashboard()).toEqual({ name: "Untitled dashboard", description: "", layout: { version: 1, tiles: [] }, filters: { version: 1, items: [] }, settings: { version: 1, crossFiltering: false, autoRefreshMinutes: 0 } });
    expect(dashboardSettingsSchema.parse({ version: 1 })).toEqual({ version: 1, crossFiltering: false, autoRefreshMinutes: 0 });
  });
  it("validates all four tile types, saved-view references, and inline Explore config", () => {
    const base = { id: "base", x: 0, y: 0, w: 6, h: 4, title: "", subtitle: "", numberFormat: "auto" as const, showLegend: true };
    const result = dashboardDocumentSchema.parse(document(
      { ...base, id: "chart", type: "chart", source: { kind: "view", viewId } } as DashboardTile,
      { ...base, id: "inline", x: 6, type: "chart", source: { kind: "inline", config: { ...createEmptyView(), values: ["sales"] } } } as DashboardTile,
      { ...base, id: "kpi", y: 4, type: "kpi", measure: "sales", comparisonMeasure: "sales:yoy" } as DashboardTile,
      { ...base, id: "slicer", x: 6, y: 4, type: "slicer", attribute: { table: "product", column: "category" } } as DashboardTile,
      { ...base, id: "notes", y: 8, type: "text", content: "Notes" },
    ));
    expect(result.layout.tiles.map((entry) => entry.type)).toEqual(["chart", "chart", "kpi", "slicer", "text"]);
  });
  it("rejects future versions independently for layout, filters, settings and inline view", () => {
    expect(dashboardLayoutSchema.safeParse({ version: 2, tiles: [] }).success).toBe(false);
    expect(dashboardFiltersSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
    expect(dashboardSettingsSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse({ ...document(), layout: { version: 0, tiles: [] } }).success).toBe(false);
    const bad = { ...tile("chart"), type: "chart", source: { kind: "inline", config: { ...createEmptyView(), version: 3 } } };
    expect(dashboardDocumentSchema.safeParse(document(bad as DashboardTile)).success).toBe(false);
  });
  it("rejects unknown fields and HTML/SQL rendering instructions while retaining plain text", () => {
    expect(dashboardDocumentSchema.safeParse({ ...document(), sql: "SELECT 1" }).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse({ ...document(), layout: { version: 1, tiles: [{ ...tile("text"), html: "<script>bad()</script>" }] } }).success).toBe(false);
    expect(dashboardDocumentSchema.parse(document({ ...tile("text"), content: "# Notes\n**Bold** <script>plain text</script>" } as DashboardTile)).layout.tiles[0].type).toBe("text");
  });
  it("rejects duplicate IDs, overlap, out-of-grid tiles, and excessive document sizes", () => {
    expect(dashboardDocumentSchema.safeParse(document(tile("same"), tile("same", 6))).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse(document(tile("a"), tile("b", 3))).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse(document(tile("a", 10))).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse(document(tile("a", 0, MAX_GRID_ROWS - 1))).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse(document(...Array.from({ length: 61 }, (_, index) => tile(String(index), 0, index * 4)))).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse(document({ ...tile("text"), content: "x".repeat(20_001) } as DashboardTile)).success).toBe(false);
    expect(dashboardDocumentSchema.safeParse({ ...document(), name: " " }).success).toBe(false);
  });
  it("validates auto-refresh intervals, filters, identifiers, and timestamps on saved records", () => {
    for (const autoRefreshMinutes of [0, 1, 5, 15]) expect(dashboardSettingsSchema.safeParse({ version: 1, autoRefreshMinutes }).success).toBe(true);
    for (const autoRefreshMinutes of [-1, 2, 60]) expect(dashboardSettingsSchema.safeParse({ version: 1, autoRefreshMinutes }).success).toBe(false);
    expect(dashboardFiltersSchema.safeParse({ version: 1, items: [{ attribute: { table: "product", column: "category" }, op: "in" }] }).success).toBe(false);
    const saved = { ...document(), id: viewId, projectId: viewId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(savedDashboardSchema.safeParse(saved).success).toBe(true);
    expect(savedDashboardSchema.safeParse({ ...saved, id: "not-an-id" }).success).toBe(false);
    expect(savedDashboardSchema.safeParse({ ...saved, updatedAt: "yesterday" }).success).toBe(false);
  });
});

describe("12-column dashboard layout", () => {
  it("allows touching edges without collisions", () => {
    const original = [tile("a"), tile("b", 6), tile("c", 0, 4)];
    expect(normalizeLayout(original)).toEqual(original);
    valid(original);
  });
  it("pushes overlapping tiles down transitively while the moved tile owns its new location", () => {
    const original = [tile("a"), tile("b", 6), tile("c", 0, 4, 12, 3)];
    const actual = moveTile(original, "a", 6, 0);
    expect(positions(actual)).toEqual([
      { id: "a", x: 6, y: 0, w: 6, h: 4 }, { id: "b", x: 6, y: 4, w: 6, h: 4 }, { id: "c", x: 0, y: 8, w: 12, h: 3 },
    ]);
    valid(actual);
    expect(original[0].x).toBe(0);
  });
  it("snaps fractional positions and clamps movement to grid edges", () => {
    expect(positions(moveTile([tile("a")], "a", 2.6, 3.4))).toEqual([{ id: "a", x: 3, y: 3, w: 6, h: 4 }]);
    expect(positions(moveTile([tile("a")], "a", 99, -40))).toEqual([{ id: "a", x: 6, y: 0, w: 6, h: 4 }]);
    expect(moveTile([tile("a")], "a", Infinity, NaN)[0]).toMatchObject({ x: 0, y: 0 });
  });
  it("resizes from the same origin, enforces width/height limits, and pushes colliders", () => {
    const enlarged = resizeTile([tile("a"), tile("b", 6), tile("c", 0, 4, 12, 3)], "a", 12, 6);
    expect(enlarged[0]).toMatchObject({ x: 0, y: 0, w: 12, h: 6 });
    expect(enlarged[1].y).toBe(6);
    expect(enlarged[2].y).toBe(10);
    valid(enlarged);
    expect(resizeTile([tile("edge", 10, 0, 2, 4)], "edge", 30, 50)[0]).toMatchObject({ x: 10, w: 2, h: 24 });
    expect(resizeTile([tile("a")], "a", -2, -2)[0]).toMatchObject({ w: 1, h: 2 });
  });
  it("maps arrow keys to moves and Shift+arrows to bounded resize", () => {
    const original = [tile("a", 2, 3, 4, 4)];
    expect(keyboardTile(original, "a", "ArrowLeft")[0]).toMatchObject({ x: 1, y: 3, w: 4, h: 4 });
    expect(keyboardTile(original, "a", "ArrowDown")[0]).toMatchObject({ x: 2, y: 4 });
    expect(keyboardTile(original, "a", "ArrowRight", true)[0]).toMatchObject({ x: 2, y: 3, w: 5, h: 4 });
    expect(keyboardTile(original, "a", "ArrowUp", true)[0]).toMatchObject({ w: 4, h: 3 });
    expect(keyboardTile(original, "a", "Enter")).toBe(original);
    expect(moveTile(original, "missing", 0, 0)).toBe(original);
    expect(resizeTile(original, "missing", 12, 8)).toBe(original);
    expect(keyboardTile(original, "missing", "ArrowDown")).toBe(original);
  });
  it("is deterministic for ties and preserves DOM order rather than reordering tile IDs", () => {
    const original = [tile("z", 0, 0, 4, 2), tile("a", 0, 0, 4, 2), tile("m", 0, 0, 4, 2)];
    const actual = normalizeLayout(original);
    expect(actual.map((entry) => entry.id)).toEqual(["z", "a", "m"]);
    expect(actual.map((entry) => entry.y)).toEqual([0, 2, 4]);
    expect(normalizeLayout(actual)).toEqual(actual);
    expect(normalizeLayout(original)).toEqual(actual);
    valid(actual);
  });
  it("keeps boundary collisions printable and appends new tiles below the current bottom", () => {
    const nearBottom = normalizeLayout([tile("a", 0, MAX_GRID_ROWS - 4), tile("b", 0, MAX_GRID_ROWS - 4)], "a");
    expect(nearBottom[0].y).toBe(MAX_GRID_ROWS - 4);
    expect(nearBottom[1].y).toBe(0);
    valid(nearBottom);
    const appended = appendTile([tile("a"), tile("b", 6, 4, 6, 3)], tile("new"));
    expect(appended.at(-1)?.y).toBe(7);
    valid(appended);
  });
  it("normalizes 60 intersecting tiles without overlap and rejects ambiguous IDs", () => {
    const input = Array.from({ length: 60 }, (_, index) => tile(String(index), 0, 0, 12, 24));
    const result = normalizeLayout(input);
    expect(result.at(-1)?.y).toBe(59 * 24);
    valid(result);
    expect(() => normalizeLayout([tile("same"), tile("same")])).toThrow(/unique/);
  });
});

describe("dashboard undo and redo", () => {
  it("restores both settings and layout edits without mutating the input document", () => {
    const original = document(tile("a"));
    const initial = createDashboardHistory(original);
    const moved = { ...original, layout: { version: 1 as const, tiles: moveTile(original.layout.tiles, "a", 3, 4) } };
    const edited = { ...moved, settings: { ...moved.settings, crossFiltering: true } };
    const afterMove = dashboardHistoryReducer(initial, { type: "set", document: moved });
    const afterSettings = dashboardHistoryReducer(afterMove, { type: "set", document: edited });
    const undone = dashboardHistoryReducer(afterSettings, { type: "undo" });
    expect(undone.present).toEqual(moved);
    const undoneTwice = dashboardHistoryReducer(undone, { type: "undo" });
    expect(undoneTwice.present).toEqual(original);
    expect(dashboardHistoryReducer(dashboardHistoryReducer(undoneTwice, { type: "redo" }), { type: "redo" }).present).toEqual(edited);
    expect(original.layout.tiles[0].x).toBe(0);
  });
  it("caps history at 50 steps and does not add no-op edits", () => {
    let state = createDashboardHistory(document());
    expect(dashboardHistoryReducer(state, { type: "set", document: document() })).toBe(state);
    for (let index = 1; index <= 60; index++) state = dashboardHistoryReducer(state, { type: "set", document: { ...state.present, name: `Revision ${index}` } });
    expect(state.past).toHaveLength(DASHBOARD_HISTORY_LIMIT);
    for (let index = 0; index < 50; index++) state = dashboardHistoryReducer(state, { type: "undo" });
    expect(state.present.name).toBe("Revision 10");
    expect(state.future).toHaveLength(50);
    expect(dashboardHistoryReducer(state, { type: "undo" })).toBe(state);
  });
  it("clears redo on a new branch and resets history after a different dashboard loads", () => {
    let state = createDashboardHistory(document());
    state = dashboardHistoryReducer(state, { type: "set", document: { ...state.present, name: "First" } });
    state = dashboardHistoryReducer(state, { type: "undo" });
    state = dashboardHistoryReducer(state, { type: "set", document: { ...state.present, name: "Replacement" } });
    expect(state.future).toEqual([]);
    expect(dashboardHistoryReducer(state, { type: "redo" })).toBe(state);
    expect(dashboardHistoryReducer(state, { type: "reset", document: document(tile("fresh")) })).toEqual(createDashboardHistory(document(tile("fresh"))));
  });
});
