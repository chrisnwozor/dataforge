export interface WindowOptions {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan?: number;
}
export interface VirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  paddingBottom: number;
}

/** End is exclusive. Clamping also handles a shorter result arriving while scrolled. */
export function calculateWindow({ count, scrollTop, viewportHeight, rowHeight, overscan = 6 }: WindowOptions): VirtualWindow {
  const size = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  const height = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 36;
  const viewport = Math.max(height, Number.isFinite(viewportHeight) ? viewportHeight : height);
  const scroll = Math.min(Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0), Math.max(0, size * height - viewport));
  const extra = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : 6));
  const start = Math.max(0, Math.floor(scroll / height) - extra);
  const end = Math.min(size, Math.ceil((scroll + viewport) / height) + extra);
  return { start, end, offsetTop: start * height, totalHeight: size * height, paddingBottom: Math.max(0, (size - end) * height) };
}

export const getVirtualWindow = calculateWindow;
