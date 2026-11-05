"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { bandScale, compactTick, donutArc, lineSegments, linearScale, niceTicks, numericDomain, shortenLabel, fitAxisLabel, wrapAxisLabel, seriesDash, seriesMarker } from "./scales";
import type { ChartDatum, ChartSeries, ExploreChartProps } from "./types";
import styles from "./charts.module.css";

const palette = Array.from({ length: 8 }, (_, index) => `var(--chart-${index + 1})`);
const formatDefault = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;

function useFrameSize(fitToContainer: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 340, labelSize: 12 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const width = Math.max(180, Math.floor(bounds.width));
      const height = fitToContainer ? Math.max(64, Math.floor(bounds.height)) : width < 420 ? 300 : 340;
      const labelSize = Math.max(12, parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75);
      setSize((previous) => previous.width === width && previous.height === height && previous.labelSize === labelSize ? previous : { width, height, labelSize });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const preferences = new MutationObserver(update);
    preferences.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-text-size"] });
    return () => { observer.disconnect(); preferences.disconnect(); };
  }, [fitToContainer]);
  return { ref, ...size };
}

/** A windowed semantic table keeps the chart's accessible fallback useful at 50,000 rows. */
function ChartDataTable({ data, series, title }: { data: ChartDatum[]; series: ChartSeries[]; title: string }) {
  const [open, setOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [columnPage, setColumnPage] = useState(0);
  const rowHeight = 36;
  const start = Math.max(0, Math.min(data.length - 1, Math.floor(scrollTop / rowHeight) - 5));
  const end = Math.min(data.length, start + 22);
  const page = Math.min(columnPage, Math.max(0, Math.ceil(series.length / 8) - 1));
  const visibleSeries = series.slice(page * 8, page * 8 + 8);
  return <details className={styles.fallback} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>View accessible data table <span className="mono">({data.length.toLocaleString("en-US")} rows)</span></summary>
    {open && <>
      {series.length > 8 && <div className={styles.columnPages}>
        <span aria-live="polite">Measures {page * 8 + 1}–{Math.min(series.length, page * 8 + 8)} of {series.length.toLocaleString("en-US")}</span>
        <button type="button" className="button button-secondary" disabled={page === 0} onClick={() => setColumnPage(Math.max(0, page - 1))} aria-label="Previous measures in chart data table">Previous</button>
        <button type="button" className="button button-secondary" disabled={(page + 1) * 8 >= series.length} onClick={() => setColumnPage(page + 1)} aria-label="Next measures in chart data table">Next</button>
      </div>}
      <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${title} chart data`} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <table className={styles.dataTable} aria-rowcount={data.length + 1}>
        <caption className={styles.srOnly}>{title}: all chart values. Scroll to read more rows.</caption>
        <thead><tr><th scope="col">Category</th>{visibleSeries.map((item) => <th scope="col" key={item.key}>{item.label}</th>)}</tr></thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true"><td colSpan={visibleSeries.length + 1} style={{ height: start * rowHeight, padding: 0, border: 0 }} /></tr>}
          {data.slice(start, end).map((datum, index) => <tr key={datum.key} aria-rowindex={start + index + 2} style={{ height: rowHeight }}><th scope="row" title={datum.label || "No value"}>{datum.label || "—"}</th>{visibleSeries.map((item) => <td key={item.key} title={number(datum.values[item.key]) === null ? "No value" : undefined}>{(item.format ?? formatDefault)(number(datum.values[item.key]))}</td>)}</tr>)}
          {end < data.length && <tr aria-hidden="true"><td colSpan={visibleSeries.length + 1} style={{ height: (data.length - end) * rowHeight, padding: 0, border: 0 }} /></tr>}
        </tbody>
      </table>
      </div>
    </>}
  </details>;
}

function colorFor(index: number, colors: string[]) {
  const override = colors[index % Math.max(1, colors.length)];
  return override && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(override) ? override : palette[index % palette.length];
}

export function ExploreChart({ kind, data, series: allSeries, title, fitToContainer = false, horizontal = false, stacked = false, showLegend = true, showValueLabels = false, colors = [], onMemberClick }: ExploreChartProps) {
  const { ref, width, height, labelSize } = useFrameSize(fitToContainer);
  const id = useId();
  const [valueLabels, setValueLabels] = useState(showValueLabels);
  const [hovered, setHovered] = useState<{ datum: ChartDatum; series?: ChartSeries } | null>(null);
  // A column shelf can expand 64 measures into thousands of series. Bound the
  // SVG independently of category count; the fallback still exposes all values.
  const series = useMemo(() => allSeries.slice(0, 12), [allSeries]);
  const points = useMemo(() => data.slice(0, kind === "donut" ? 50 : 200), [data, kind]);
  const summary = useMemo(() => {
    if (!data.length || !series.length) return "No values to display. Add a measure or change your filters.";
    const first = series[0];
    let low = Infinity, high = -Infinity, count = 0;
    for (const datum of data) {
      const value = number(datum.values[first.key]);
      if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); count++; }
    }
    return `${data.length.toLocaleString("en-US")} categories and ${allSeries.length} ${allSeries.length === 1 ? "measure" : "measures"}. ${first.label}${count ? ` ranges from ${(first.format ?? formatDefault)(low)} to ${(first.format ?? formatDefault)(high)}.` : " has no numeric values."}${onMemberClick ? " Select a mark to explore its member." : ""}`;
  }, [data, series, allSeries.length, onMemberClick]);

  const activation = (datum: ChartDatum, item?: ChartSeries) => ({
    tabIndex: 0,
    role: onMemberClick ? "button" as const : "img" as const,
    "aria-label": `${datum.label || "—"}${item ? `, ${item.label}: ${(item.format ?? formatDefault)(number(datum.values[item.key]))}` : ""}${onMemberClick ? ". Explore member" : ""}`,
    onMouseEnter: () => setHovered({ datum, series: item }),
    onMouseLeave: () => setHovered(null),
    onFocus: () => setHovered({ datum, series: item }),
    onBlur: () => setHovered(null),
    onClick: () => onMemberClick?.(datum),
    onKeyDown: (event: React.KeyboardEvent<SVGElement>) => {
      if (onMemberClick && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onMemberClick(datum); }
      if (event.key === "Escape") setHovered(null);
    },
    className: styles.mark,
    "data-chart-mark": true,
  });

  const margin = { left: horizontal && kind === "bar" ? Math.min(144, width * 0.34) : width < 420 ? 56 : 72, top: height < 160 ? 8 : 20, right: 16, bottom: Math.max(height < 160 ? 36 : 54, labelSize * 3.8) };
  const plotRight = Math.max(margin.left + 20, width - margin.right);
  const plotBottom = Math.max(margin.top + 20, height - margin.bottom);
  const allValues = useMemo(() => {
    if (kind === "bar" && stacked) return points.flatMap((datum) => {
      let positive = 0, negative = 0;
      for (const item of series) { const value = number(datum.values[item.key]) ?? 0; if (value >= 0) positive += value; else negative += value; }
      return [positive, negative];
    });
    return points.flatMap((datum) => series.map((item) => number(datum.values[item.key])));
  }, [kind, stacked, points, series]);
  const [domainLow, domainHigh] = numericDomain(allValues);
  const ticks = niceTicks(domainLow, domainHigh, width < 420 ? 4 : 5);
  const tickDomain: [number, number] = [ticks[0], ticks[ticks.length - 1]];
  const scale = linearScale(tickDomain, horizontal && kind === "bar" ? [margin.left, plotRight] : [plotBottom, margin.top]);
  const bands = bandScale(points.length, horizontal && kind === "bar" ? margin.top : margin.left, horizontal && kind === "bar" ? plotBottom : plotRight);
  const labelEvery = Math.max(1, Math.ceil(points.length / (horizontal && kind === "bar" ? Math.max(2, Math.floor((plotBottom - margin.top) / 24)) : width < 420 ? 4 : 7)));
  const labelWidth = horizontal && kind === "bar" ? margin.left - 16 : Math.max(12, Math.abs(bands.step) * labelEvery - 8);
  const labeledPoints = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor((plotRight - margin.left) / 72))));
  const patternId = (index: number) => `${id}-pattern-${index}`;
  const patternedFill = (index: number) => `url(#${patternId(index)})`;
  const renderValueLabel = (datum: ChartDatum, item: ChartSeries, x: number, y: number, available: number) => {
    const value = number(datum.values[item.key]);
    if (!valueLabels || value === null) return null;
    const text = (item.format ?? formatDefault)(value);
    return <text className={styles.valueLabel} x={x} y={Math.max(margin.top + labelSize, Math.min(plotBottom, y))} textAnchor="middle" aria-hidden="true">{fitAxisLabel(text, available, labelSize)}<title>{`${datum.label || "No value"}: ${item.label} ${text}`}</title></text>;
  };

  const legend = kind === "donut"
    ? points.slice(0, 12).map((datum, index) => ({ key: datum.key, label: datum.label, color: colorFor(index, colors) }))
    : series.map((item, index) => ({ key: item.key, label: item.label, color: colorFor(index, colors) }));

  const renderCartesian = () => <>
    <g className={styles.axes} aria-hidden="true">
      {ticks.map((tick) => horizontal && kind === "bar"
        ? <g key={tick}><line x1={scale(tick)} x2={scale(tick)} y1={margin.top} y2={plotBottom} /><text x={scale(tick)} y={plotBottom + 22} textAnchor="middle">{compactTick(tick)}</text></g>
        : <g key={tick}><line x1={margin.left} x2={plotRight} y1={scale(tick)} y2={scale(tick)} /><text x={margin.left - 10} y={scale(tick) + 4} textAnchor="end">{compactTick(tick)}</text></g>)}
      {points.map((datum, index) => index % labelEvery === 0 && (horizontal && kind === "bar"
        ? <text key={datum.key} x={margin.left - 8} y={bands.center(index) + 4} textAnchor="end">{wrapAxisLabel(datum.label || "—", labelWidth, labelSize).map((line, lineIndex, lines) => <tspan key={lineIndex} x={margin.left - 8} dy={lineIndex ? labelSize * 1.2 : -(lines.length - 1) * labelSize * 0.6}>{line}</tspan>)}<title>{datum.label || "No value"}</title></text>
        : <text key={datum.key} x={bands.center(index)} y={plotBottom + labelSize * 1.6} textAnchor="middle">{wrapAxisLabel(datum.label || "—", labelWidth, labelSize).map((line, lineIndex) => <tspan key={lineIndex} x={bands.center(index)} dy={lineIndex ? labelSize * 1.2 : 0}>{line}</tspan>)}<title>{datum.label || "No value"}</title></text>))}
    </g>
    {kind === "bar" ? points.map((datum, pointIndex) => {
      let positive = 0, negative = 0;
      return <g key={datum.key}>{series.map((item, seriesIndex) => {
        const value = number(datum.values[item.key]);
        if (value === null) return null;
        const from = stacked ? value >= 0 ? positive : negative : 0;
        const to = from + value;
        if (stacked) { if (value >= 0) positive = to; else negative = to; }
        const breadth = bands.bandwidth / (stacked ? 1 : Math.max(1, series.length));
        const groupPosition = bands.at(pointIndex) + (stacked ? 0 : seriesIndex * breadth);
        return <g key={item.key}><rect {...activation(datum, item)} x={horizontal ? Math.min(scale(from), scale(to)) : groupPosition} y={horizontal ? groupPosition : Math.min(scale(from), scale(to))} width={horizontal ? Math.max(1, Math.abs(scale(to) - scale(from))) : Math.max(0.5, breadth - 1)} height={horizontal ? Math.max(0.5, breadth - 1) : Math.max(1, Math.abs(scale(to) - scale(from)))} fill={patternedFill(seriesIndex)} rx={1}><title>{`${datum.label}: ${item.label} ${(item.format ?? formatDefault)(value)}`}</title></rect>{pointIndex % (horizontal ? labelEvery : labeledPoints) === 0 && renderValueLabel(datum, item, horizontal ? (scale(from) + scale(to)) / 2 : groupPosition + breadth / 2, horizontal ? groupPosition + breadth / 2 + labelSize / 3 : Math.min(scale(from), scale(to)) - 6, horizontal ? Math.abs(scale(to) - scale(from)) - 8 : Math.max(12, breadth - 4))}</g>;
      })}</g>;
    }) : series.map((item, seriesIndex) => {
      const segments = lineSegments(points.map((datum, index) => {
        const value = number(datum.values[item.key]);
        return value === null ? null : { x: bands.center(index), y: scale(value) };
      }));
      return <g key={item.key}>
        {segments.map((segment, index) => {
          const path = segment.map((point, pointIndex) => `${pointIndex ? "L" : "M"}${point.x},${point.y}`).join(" ");
          return <g key={index}>{kind === "area" && <path d={`${path} L${segment[segment.length - 1].x},${scale(0)} L${segment[0].x},${scale(0)} Z`} fill={patternedFill(seriesIndex)} fillOpacity={0.2} stroke="none" />}<path d={path} fill="none" stroke={colorFor(seriesIndex, colors)} strokeWidth={2} strokeDasharray={seriesDash(seriesIndex)} vectorEffect="non-scaling-stroke" /></g>;
        })}
        {points.map((datum, index) => number(datum.values[item.key]) !== null && <g key={datum.key}><path {...activation(datum, item)} d={seriesMarker(seriesIndex, bands.center(index), scale(datum.values[item.key] as number))} fill={colorFor(seriesIndex, colors)} stroke="var(--surface)" strokeWidth={1.5}><title>{`${datum.label}: ${item.label} ${(item.format ?? formatDefault)(datum.values[item.key])}`}</title></path>{index % labeledPoints === 0 && renderValueLabel(datum, item, bands.center(index), scale(datum.values[item.key] as number) - 9, bands.step * labeledPoints - 8)}</g>)}
      </g>;
    })}
  </>;

  const renderDonut = () => {
    const item = series[0];
    if (!item) return null;
    const positive = points.map((datum) => Math.max(0, number(datum.values[item.key]) ?? 0));
    const total = positive.reduce((sum, value) => sum + value, 0);
    let angle = -Math.PI / 2;
    const radius = Math.max(12, Math.min(width / 2 - 20, height / 2 - 24, 105));
    return <g transform={`translate(${width / 2},${height / 2 - 8})`}>
      {total > 0 ? points.map((datum, index) => {
        if (!positive[index]) return null;
        const start = angle;
        angle += positive[index] / total * Math.PI * 2;
        const middle = (start + angle) / 2;
        return <g key={datum.key}><path {...activation(datum, item)} d={donutArc(start, angle, radius, radius * 0.64)} fill={patternedFill(index)} stroke="var(--surface)" strokeWidth={2}><title>{`${datum.label}: ${(item.format ?? formatDefault)(positive[index])}`}</title></path>{valueLabels && points.length <= 8 && <text x={Math.cos(middle) * radius * 0.84} y={Math.sin(middle) * radius * 0.84 + 4} className={styles.valueLabel} textAnchor="middle" aria-hidden="true">{fitAxisLabel((item.format ?? formatDefault)(positive[index]), radius * 0.72, labelSize)}<title>{`${datum.label}: ${(item.format ?? formatDefault)(positive[index])}`}</title></text>}</g>;
      }) : <circle r={radius * 0.8} fill="none" stroke="var(--line)" strokeWidth={radius * 0.36} />}
      <text textAnchor="middle" y={-3} className={styles.donutLabel}>{fitAxisLabel(item.label, radius * 1.1, labelSize)}<title>{item.label}</title></text>
      <text textAnchor="middle" y={20} className={styles.donutCount}>{total > 0 ? `${points.filter((_, index) => positive[index] > 0).length} members` : "No positive values"}</text>
    </g>;
  };

  const renderKpi = () => {
    const itemWidth = width < 440 ? width - 16 : Math.max(160, (width - 16) / Math.min(3, series.length));
    const columns = Math.max(1, Math.floor((width - 8) / itemWidth));
    return series.map((item, index) => {
      const datum = data[0];
      const x = 8 + (index % columns) * itemWidth;
      const y = 8 + Math.floor(index / columns) * 110;
      return <g key={item.key} {...(datum ? activation(datum, item) : {})} transform={`translate(${x},${y})`}>
        <rect width={itemWidth - 8} height={100} rx={6} fill="var(--raised)" stroke="var(--line)" />
        <text x={16} y={27} className={styles.kpiLabel}>{shortenLabel(item.label, Math.max(12, Math.floor(itemWidth / 8)))}<title>{item.label}</title></text>
        <text x={16} y={63} className={styles.kpiValue}>{shortenLabel((item.format ?? formatDefault)(number(datum?.values[item.key])), Math.max(10, Math.floor(itemWidth / 15)))}<title>{number(datum?.values[item.key]) === null ? "No value" : (item.format ?? formatDefault)(number(datum?.values[item.key]))}</title></text>
        {data.length > 1 && <text x={16} y={85} className={styles.kpiContext}>{shortenLabel(datum?.label || "—", Math.floor(itemWidth / 7))}<title>{datum?.label || "No value"}</title></text>}
      </g>;
    });
  };
  const kpiColumns = width < 440 ? 1 : Math.max(1, Math.min(3, Math.floor((width - 8) / 160)));
  const actualHeight = kind === "kpi" ? Math.max(120, Math.ceil(series.length / kpiColumns) * 110 + 16) : height;

  return <section className={`${styles.chart} ${fitToContainer ? styles.fitted : ""}`} data-chart-fit={fitToContainer || undefined} aria-label={`${title} visualization`}>
    <p className={styles.summary}>{summary}</p>
    {kind !== "kpi" && <label className={styles.valueControl}><input type="checkbox" checked={valueLabels} onChange={(event) => setValueLabels(event.currentTarget.checked)} />Show value labels<span className={styles.srOnly}> for {title}</span></label>}
    <div ref={ref} className={styles.frame}>
      <svg data-explore-chart="true" className={styles.svg} viewBox={`0 0 ${width} ${actualHeight}`} width="100%" height={actualHeight} role="group" aria-roledescription="chart" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>{title}</title><desc id={`${id}-description`}>{summary} The data table below provides all values.</desc>
        <defs>{Array.from({ length: kind === "donut" ? points.length : series.length }, (_, index) => <pattern id={patternId(index)} key={index} width={8 + index % 3 * 2} height={8 + index % 3 * 2} patternUnits="userSpaceOnUse" patternTransform={`rotate(${index % 4 * 45})`}><rect width="100%" height="100%" fill={colorFor(index, colors)} />{index > 0 && (index % 2 ? <path d="M0,0 L0,12" stroke="var(--surface)" strokeWidth={1.5} /> : <circle cx={3} cy={3} r={1.2} fill="var(--surface)" />)}</pattern>)}</defs>
        {data.length && series.length ? kind === "donut" ? renderDonut() : kind === "kpi" ? renderKpi() : renderCartesian() : <text x={width / 2} y={height / 2} textAnchor="middle" fill="var(--muted)">No values to display</text>}
      </svg>
      {hovered && <div className={styles.tooltip} role="status"><strong>{hovered.datum.label || "—"}</strong>{(hovered.series ? [hovered.series] : series).map((item) => <span key={item.key}>{item.label}<b>{(item.format ?? formatDefault)(number(hovered.datum.values[item.key]))}</b></span>)}</div>}
    </div>
    {showLegend && kind !== "kpi" && <details className={styles.legendDisclosure} open={!fitToContainer}><summary>Chart legend ({legend.length})</summary><ul className={styles.legend} aria-label="Chart legend">{legend.map((item, index) => <li key={item.key}><svg width={22} height={16} viewBox="0 0 22 16" aria-hidden="true">{kind === "line" || kind === "area" ? <><path d="M0,8 H22" stroke={item.color} strokeWidth={2} strokeDasharray={seriesDash(index)} /><path d={seriesMarker(index, 11, 8, 3)} fill={item.color} stroke="var(--surface)" /></> : <rect x={1} y={1} width={20} height={14} rx={2} fill={patternedFill(index)} />}</svg>{item.label || <span title="No value">—</span>}</li>)}{kind === "donut" && points.length > 12 && <li>+{points.length - 12} in data table</li>}</ul></details>}
    {valueLabels && kind === "donut" && points.length > 8 && <p className={styles.note}>This donut has more than eight slices. Use the value tooltips or data table, or filter to eight members to show direct labels without overlap.</p>}
    {valueLabels && kind !== "donut" && kind !== "kpi" && labeledPoints > 1 && <p className={styles.note}>Value labels are spaced to avoid overlap. Focus a mark or open the data table for every value.</p>}
    {data.length > points.length && kind !== "kpi" && <p className={styles.note}>Showing the first {points.length} of {data.length.toLocaleString("en-US")} categories. Filter or use the table to explore all values.</p>}
    {allSeries.length > series.length && <p className={styles.note}>Showing the first {series.length} of {allSeries.length.toLocaleString("en-US")} measure series. The data table includes every series, with eight columns per page.</p>}
    {kind === "donut" && <p className={styles.note}>Slices show positive values of {series[0]?.label ?? "the first measure"}. Zero, negative and missing values remain in the data table.</p>}
    {kind === "kpi" && data.length > 1 && <p className={styles.note}>Cards show the first category. Remove grouping fields to show overall measures.</p>}
    <ChartDataTable data={data} series={allSeries} title={title} />
  </section>;
}
