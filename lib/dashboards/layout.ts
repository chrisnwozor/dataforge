import { GRID_COLUMNS, MAX_GRID_ROWS, MAX_TILE_HEIGHT, MIN_TILE_HEIGHT, tilesOverlap, type DashboardTile } from "./schema";

export { GRID_COLUMNS, MAX_GRID_ROWS, MAX_TILE_HEIGHT, MIN_TILE_HEIGHT, tilesOverlap } from "./schema";

const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.round(value) : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function bound(tile: DashboardTile): DashboardTile {
  const w = clamp(integer(tile.w, 1), 1, GRID_COLUMNS);
  const h = clamp(integer(tile.h, MIN_TILE_HEIGHT), MIN_TILE_HEIGHT, MAX_TILE_HEIGHT);
  return { ...tile, w, h, x: clamp(integer(tile.x, 0), 0, GRID_COLUMNS - w), y: clamp(integer(tile.y, 0), 0, MAX_GRID_ROWS - h) };
}

function pushDown(tile: DashboardTile, placed: DashboardTile[]): DashboardTile {
  let current = tile;
  for (let count = 0; count <= placed.length; count++) {
    const collisions = placed.filter((other) => tilesOverlap(current, other));
    if (!collisions.length) return current;
    current = { ...current, y: Math.max(...collisions.map((other) => other.y + other.h)) };
  }
  return current;
}

/**
 * Keep the edited tile at its snapped location and push intersecting tiles down.
 * DOM order remains unchanged; placement order is visual and deterministic.
 */
export function normalizeLayout(tiles: DashboardTile[], activeId?: string): DashboardTile[] {
  if (new Set(tiles.map((tile) => tile.id)).size !== tiles.length) throw new Error("Dashboard tile IDs must be unique.");
  const ordered = tiles.map((tile, index) => ({ tile: bound(tile), index })).sort((left, right) => {
    if (left.index === right.index) return 0;
    if (left.tile.id === activeId) return -1;
    if (right.tile.id === activeId) return 1;
    return left.tile.y - right.tile.y || left.tile.x - right.tile.x || left.index - right.index;
  });
  const placed: DashboardTile[] = [];
  for (const { tile } of ordered) {
    let next = pushDown(tile, placed);
    // Extremely low placement must not push an adjacent tile beyond the bounded
    // printable grid. At most 60 tiles fit into the empty space above it.
    if (next.y + next.h > MAX_GRID_ROWS) next = pushDown({ ...tile, y: 0 }, placed);
    placed.push(next);
  }
  const byId = new Map(placed.map((tile) => [tile.id, tile]));
  return tiles.map((tile) => byId.get(tile.id)!);
}

export function moveTile(tiles: DashboardTile[], id: string, x: number, y: number): DashboardTile[] {
  if (!tiles.some((tile) => tile.id === id)) return tiles;
  return normalizeLayout(tiles.map((tile) => tile.id === id ? { ...tile, x, y } : tile), id);
}

export function resizeTile(tiles: DashboardTile[], id: string, width: number, height: number): DashboardTile[] {
  const tile = tiles.find((item) => item.id === id);
  if (!tile) return tiles;
  const w = clamp(integer(width, tile.w), 1, GRID_COLUMNS - tile.x);
  const h = clamp(integer(height, tile.h), MIN_TILE_HEIGHT, Math.min(MAX_TILE_HEIGHT, MAX_GRID_ROWS - tile.y));
  return normalizeLayout(tiles.map((item) => item.id === id ? { ...item, w, h } : item), id);
}

/** Arrow keys move one cell; Shift+arrows resize one cell from the lower right. */
export function keyboardTile(tiles: DashboardTile[], id: string, key: string, shiftKey = false): DashboardTile[] {
  const tile = tiles.find((item) => item.id === id);
  if (!tile) return tiles;
  const delta = key === "ArrowLeft" ? [-1, 0] : key === "ArrowRight" ? [1, 0] : key === "ArrowUp" ? [0, -1] : key === "ArrowDown" ? [0, 1] : null;
  if (!delta) return tiles;
  return shiftKey ? resizeTile(tiles, id, tile.w + delta[0], tile.h + delta[1]) : moveTile(tiles, id, tile.x + delta[0], tile.y + delta[1]);
}

/** New tiles start after the current bottom, avoiding a full-grid collision. */
export function appendTile(tiles: DashboardTile[], tile: DashboardTile): DashboardTile[] {
  const y = tiles.length ? Math.max(...tiles.map((item) => item.y + item.h)) : 0;
  return normalizeLayout([...tiles, { ...tile, y }], tile.id);
}
