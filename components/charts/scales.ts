/** Small, deterministic scale helpers. No DOM or chart-library dependencies. */
export function finiteValues(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function niceTicks(minimum: number, maximum: number, count = 5): number[] {
  let min = Number.isFinite(minimum) ? minimum : 0;
  let max = Number.isFinite(maximum) ? maximum : 1;
  if (min > max) [min, max] = [max, min];
  // Normalize before subtraction. Opposite, finite 1e308 endpoints otherwise
  // overflow their span, while subnormal endpoints can underflow a tick step.
  const magnitude = 10 ** Math.max(-308, Math.min(308, Math.floor(Math.log10(Math.max(Math.abs(min), Math.abs(max)) || 1))));
  let normalizedMin = min / magnitude;
  let normalizedMax = max / magnitude;
  if (normalizedMin === normalizedMax) {
    const padding = Math.abs(normalizedMin) * 0.1 || 1;
    normalizedMin -= padding;
    normalizedMax += padding;
  }
  const target = Math.max(2, Math.min(20, Math.round(count)));
  const rough = (normalizedMax - normalizedMin) / (target - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * power;
  const start = Math.floor(normalizedMin / step) * step;
  const end = Math.ceil(normalizedMax / step) * step;
  const length = Math.min(100, Math.round((end - start) / step) + 1);
  const ticks = Array.from({ length }, (_, index) => {
    const scaled = (start + step * index) * magnitude;
    const value = scaled >= Number.MAX_VALUE ? Number.MAX_VALUE : scaled <= -Number.MAX_VALUE ? -Number.MAX_VALUE : Number(scaled.toPrecision(12));
    return Object.is(value, -0) ? 0 : value;
  });
  const unique = [...new Set(ticks.filter(Number.isFinite))];
  if (unique.length > 1) return unique;
  const value = unique[0] ?? 0;
  return value > 0 ? [0, value] : value < 0 ? [value, 0] : [0, 1];
}

export function linearScale(domain: readonly [number, number], range: readonly [number, number]) {
  const [low, high] = domain;
  const [start, end] = range;
  return (value: number): number => {
    if (!Number.isFinite(value)) return start;
    if (low === high) return (start + end) / 2;
    const span = high - low;
    const magnitude = Math.max(Math.abs(low), Math.abs(high), Math.abs(value)) || 1;
    const ratio = Number.isFinite(span) ? (value - low) / span : (value / magnitude - low / magnitude) / (high / magnitude - low / magnitude);
    return start + ratio * (end - start);
  };
}

export function bandScale(count: number, start: number, end: number, gap = 0.2) {
  const size = Math.max(0, Math.floor(count));
  const step = (end - start) / Math.max(1, size);
  const padding = Math.max(0, Math.min(0.95, gap));
  return { step, bandwidth: Math.abs(step) * (1 - padding), at: (index: number) => start + step * (index + padding / 2), center: (index: number) => start + step * (index + 0.5) };
}

export function numericDomain(values: readonly (number | null)[], includeZero = true): [number, number] {
  const finite = finiteValues(values);
  let min = includeZero ? 0 : Infinity;
  let max = includeZero ? 0 : -Infinity;
  for (const value of finite) { min = Math.min(min, value); max = Math.max(max, value); }
  if (!finite.length) return [0, 1];
  if (min === max) return min === 0 ? [0, 1] : [Math.max(-Number.MAX_VALUE, min - Math.abs(min) * 0.1), Math.min(Number.MAX_VALUE, max + Math.abs(max) * 0.1)];
  return [min, max];
}

export function compactTick(value: number): string {
  const absolute = Math.abs(value);
  return new Intl.NumberFormat("en-US", { notation: absolute >= 1e15 || (absolute > 0 && absolute < 0.0001) ? "scientific" : "compact", maximumFractionDigits: 2 }).format(value);
}

export function shortenLabel(label: string, maximum = 18): string {
  return label.length > maximum ? `${label.slice(0, Math.max(1, maximum - 1))}…` : label;
}

/** Bound axis labels to their actual slot; full labels remain in SVG titles and mark tooltips. */
export function fitAxisLabel(label: string, width: number, fontSize = 10): string {
  // A conservative glyph budget avoids overlapping ticks without DOM text measurements.
  const budget = Math.max(1, Math.floor(Math.max(0, width) / (fontSize * 0.62)));
  const characters = Array.from(label);
  if (characters.length <= budget) return label;
  return budget === 1 ? "…" : `${characters.slice(0, budget - 1).join("")}…`;
}

export function donutArc(start: number, end: number, outer = 105, inner = 65): string {
  // A complete circle needs two SVG arcs; use the same path construction for every slice.
  const span = Math.min(Math.PI * 2 - 0.000001, Math.max(0, end - start));
  const angle = start + span;
  const point = (radius: number, radians: number) => `${Number((Math.cos(radians) * radius).toFixed(5))},${Number((Math.sin(radians) * radius).toFixed(5))}`;
  return `M${point(outer, start)} A${outer},${outer} 0 ${span > Math.PI ? 1 : 0} 1 ${point(outer, angle)} L${point(inner, angle)} A${inner},${inner} 0 ${span > Math.PI ? 1 : 0} 0 ${point(inner, start)} Z`;
}

/** Break paths at missing observations rather than drawing invented data across gaps. */
export function lineSegments(points: readonly ({ x: number; y: number } | null)[]): { x: number; y: number }[][] {
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}
