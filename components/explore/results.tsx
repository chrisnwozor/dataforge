"use client";

import { memo, useDeferredValue, useMemo } from "react";
import { ExploreChart, type ChartDatum, type ChartSeries } from "@/components/charts";
import { formatAttribute, formatMeasure } from "@/lib/explore/format";
import { buildPivot } from "@/lib/explore/pivot";
import type { ViewConfig } from "@/lib/explore/config";
import type { AttributeRef, QueryResult, QueryResultColumn, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import type { ExploreTotals } from "./use-explore-query";
import { useWindowedRows } from "./use-window";
import styles from "./results.module.css";

interface ResultsProps {
  config: ViewConfig;
  model: SemanticModel;
  result: QueryResult | null;
  resultConfig?: ViewConfig | null;
  totals?: ExploreTotals;
  loading?: boolean;
  onMemberClick?: (attribute: AttributeRef, value: QueryValue) => void;
}

function getAttribute(model: SemanticModel, ref?: AttributeRef): SemanticColumn | undefined {
  if (!ref) return;
  const table = model.tables.find((item) => item.id === ref.table || item.name === ref.table);
  return table?.columns.find((column) => column.id === ref.column || column.name === ref.column);
}

function measureFormat(column: QueryResultColumn, index: number, config: ViewConfig, model: SemanticModel) {
  if (config.options.numberFormat !== "auto") return config.options.numberFormat;
  const measure = model.measures.find((item) => item.id === config.values[index] || item.name === column.name);
  return measure?.format ?? "number";
}

function Member({ value, column, attribute, onMemberClick }: {
  value: QueryValue | undefined;
  column?: Pick<SemanticColumn, "name" | "type">;
  attribute?: AttributeRef;
  onMemberClick?: ResultsProps["onMemberClick"];
}) {
  const label = formatAttribute(value, column);
  if (!attribute || !onMemberClick) return <>{label}</>;
  return <button className={styles.member} type="button" onClick={() => onMemberClick(attribute, value ?? null)} aria-label={`Explore ${column?.name ?? "member"}: ${label}`}>{label}</button>;
}

const LongTable = memo(function LongTable({ result, config, model, onMemberClick }: ResultsProps & { result: QueryResult }) {
  const { attachViewport, onScroll, start, end, offsetTop, paddingBottom } = useWindowedRows(result.rows.length);
  const attributes = [...config.rows, ...config.columns];
  let attributeIndex = 0;
  let measureIndex = 0;
  const descriptors = result.columns.map((column) => column.role === "attribute"
    ? { column, attribute: attributes[attributeIndex++], measureIndex: -1 }
    : { column, attribute: undefined, measureIndex: measureIndex++ });
  return <div className={styles.viewport} ref={attachViewport} onScroll={onScroll} tabIndex={0} role="region" aria-label="Explore result table">
    <table className={styles.table} aria-rowcount={result.rows.length + 1}>
      <caption className={styles.srOnly}>Current query result, {result.rows.length.toLocaleString()} rows. Rows are windowed while scrolling.</caption>
      <thead><tr>{descriptors.map(({ column }) => <th key={column.key} scope="col">{column.name}</th>)}</tr></thead>
      <tbody>
        {offsetTop > 0 && <tr aria-hidden="true"><td colSpan={result.columns.length} style={{ height: offsetTop, padding: 0, border: 0 }} /></tr>}
        {result.rows.slice(start, end).map((row, offset) => <tr key={start + offset} aria-rowindex={start + offset + 2}>
          {descriptors.map(({ column, attribute, measureIndex }) => <td key={column.key} className={column.role === "measure" ? styles.numeric : undefined}>
            {column.role === "attribute"
              ? <Member value={row[column.key]} column={getAttribute(model, attribute) ?? column} attribute={attribute} onMemberClick={onMemberClick} />
              : formatMeasure(row[column.key], measureFormat(column, measureIndex, config, model))}
          </td>)}
        </tr>)}
        {paddingBottom > 0 && <tr aria-hidden="true"><td colSpan={result.columns.length} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>}
      </tbody>
    </table>
  </div>;
});

function PivotTable({ result, config, model, totals, onMemberClick }: ResultsProps & { result: QueryResult }) {
  const pivot = useMemo(() => buildPivot(result, config, totals), [result, config, totals]);
  const { attachViewport, onScroll, start, end, offsetTop, paddingBottom } = useWindowedRows(pivot.rows.length);
  const rowRefs = config.rows;
  const colCount = Math.max(1, rowRefs.length) + pivot.columns.length * pivot.measureColumns.length + (config.options.showTotals ? pivot.measureColumns.length : 0);
  const format = (value: QueryValue | undefined, index: number) => formatMeasure(value, measureFormat(pivot.measureColumns[index], index, config, model));
  return <>
    {pivot.truncatedColumns && <p className={styles.note} role="status">Showing at most 50 column members{pivot.totalColumnMembers > 50 ? ` of ${pivot.totalColumnMembers.toLocaleString()}` : ""}. Add a filter to narrow the pivot. Totals still reflect the server query.</p>}
    {config.options.showTotals && config.topN && <p className={styles.note}>Totals include all filtered members before Top N is applied.</p>}
    <div className={styles.viewport} ref={attachViewport} onScroll={onScroll} tabIndex={0} role="region" aria-label="Explore pivot table">
      <table className={styles.table} aria-rowcount={pivot.rows.length + 2}>
        <caption className={styles.srOnly}>Pivot with {pivot.rows.length.toLocaleString()} row members and {pivot.columns.length} column members. Totals are calculated by the semantic query API.</caption>
        <thead><tr>
          {rowRefs.length ? rowRefs.map((ref, index) => <th scope="col" key={index}>{getAttribute(model, ref)?.name ?? ref.column}</th>) : <th scope="col">Values</th>}
          {pivot.columns.flatMap((column) => pivot.measureColumns.map((measure) => <th scope="col" key={`${column.key}:${measure.key}`}>{column.members.map((member, index) => formatAttribute(member, getAttribute(model, config.columns[index]))).join(" / ")}{column.members.length ? " · " : ""}{measure.name}</th>))}
          {config.options.showTotals && pivot.measureColumns.map((measure) => <th scope="col" key={`total:${measure.key}`}>Total · {measure.name}</th>)}
        </tr></thead>
        <tbody>
          {offsetTop > 0 && <tr aria-hidden="true"><td colSpan={colCount} style={{ height: offsetTop, padding: 0, border: 0 }} /></tr>}
          {pivot.rows.slice(start, end).map((row, offset) => <tr key={row.key} aria-rowindex={start + offset + 2}>
            {rowRefs.length ? rowRefs.map((ref, index) => <td key={index}><Member value={row.members[index]} column={getAttribute(model, ref)} attribute={ref} onMemberClick={onMemberClick} /></td>) : <th scope="row">Values</th>}
            {pivot.columns.flatMap((column) => pivot.measureColumns.map((measure, index) => <td className={styles.numeric} key={`${column.key}:${measure.key}`}>{format(row.values[column.key]?.[index], index)}</td>))}
            {config.options.showTotals && pivot.measureColumns.map((measure, index) => <td className={`${styles.numeric} ${styles.total}`} key={`total:${measure.key}`}>{format(row.total[index], index)}</td>)}
          </tr>)}
          {paddingBottom > 0 && <tr aria-hidden="true"><td colSpan={colCount} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>}
        </tbody>
        {config.options.showTotals && <tfoot><tr><th scope="row" colSpan={Math.max(1, rowRefs.length)}>Grand total</th>
          {pivot.columns.flatMap((column) => pivot.measureColumns.map((measure, index) => <td className={styles.numeric} key={`${column.key}:${measure.key}`}>{format(pivot.columnTotals[column.key]?.[index], index)}</td>))}
          {pivot.measureColumns.map((measure, index) => <td className={styles.numeric} key={`total:${measure.key}`}>{format(pivot.grandTotal[index], index)}</td>)}
        </tr></tfoot>}
      </table>
    </div>
  </>;
}

function ChartResult({ result, config, model, onMemberClick }: ResultsProps & { result: QueryResult }) {
  const chart = useMemo(() => {
    const shape = config.viz === "kpi" ? { rows: [], columns: [] } : config;
    const pivot = buildPivot(result, shape);
    const refs = shape.rows;
    const series: ChartSeries[] = pivot.columns.flatMap((member) => pivot.measureColumns.map((column, index) => ({
      key: JSON.stringify([member.key, column.key]),
      label: [...member.members.map((value, level) => formatAttribute(value, getAttribute(model, shape.columns[level]))), column.name].join(" / "),
      format: (value) => formatMeasure(value, measureFormat(column, index, config, model)),
    })));
    const members = new Map<string, QueryValue>();
    const data: ChartDatum[] = pivot.rows.map((row) => {
      const key = row.key;
      if (refs.length) members.set(key, row.members[0]);
      // Keep sparse intersections sparse: 50 column members × 64 measures need not
      // allocate 3,200 empty properties for each of 50,000 row members.
      return { key, label: row.members.map((value, index) => formatAttribute(value, getAttribute(model, refs[index]))).join(" / ") || "All data", values: Object.fromEntries(Object.entries(row.values).flatMap(([memberKey, values]) => pivot.measureColumns.map((column, index) => [JSON.stringify([memberKey, column.key]), typeof values[index] === "number" ? values[index] as number : null]))) };
    });
    return { data, series, members, attribute: refs[0], count: pivot.rows.length, truncatedColumns: pivot.truncatedColumns };
  }, [result, config, model]);
  if (config.viz === "table" || config.viz === "pivot") return null;
  return <>
    {chart.truncatedColumns && <p className={styles.note}>Showing at most 50 column series members. Add a filter to narrow the chart.</p>}
    <ExploreChart kind={config.viz} title={config.options.title || "Explore your data"} data={chart.data} series={chart.series} horizontal={config.options.barOrientation === "horizontal"} stacked={config.options.stacked} showLegend={config.options.showLegend} colors={config.options.seriesColors} onMemberClick={chart.attribute && onMemberClick ? (datum) => onMemberClick(chart.attribute, chart.members.get(datum.key) ?? null) : undefined} />
  </>;
}

export function ExploreResults({ config, model, result, resultConfig, totals, loading, onMemberClick }: ResultsProps) {
  // Keep metadata and data atomic while React defers a large render or a request fails.
  const displayConfig = resultConfig ?? config;
  const snapshot = useMemo(() => ({ result, config: displayConfig, totals }), [result, displayConfig, totals]);
  const deferred = useDeferredValue(snapshot);
  if (!deferred.result) return <div className={styles.empty} role="status">{loading ? <><div className={styles.skeleton} /><div className={styles.skeleton} /><div className={styles.skeleton} /><span>Querying your warehouse…</span></> : "Add a measure and an attribute to explore your data."}</div>;
  const stale = loading || snapshot !== deferred || deferred.config !== config;
  const props = { config: deferred.config, model, result: deferred.result, totals: deferred.totals, onMemberClick: stale ? undefined : onMemberClick };
  return <div className={stale ? styles.dimmed : undefined} aria-busy={loading}>
    {deferred.result.truncated && <p className={styles.note} role="status">Query reached the 50,000-row or 50-column pivot limit. Add filters or Top N to explore a smaller result; CSV exports have the same cap.</p>}
    {deferred.result.rows.length === 0 ? <p className={styles.empty}>No results match these filters. Clear a filter or choose a different field.</p>
      : deferred.config.viz === "table" ? <LongTable {...props} />
        : deferred.config.viz === "pivot" ? <PivotTable {...props} />
          : <ChartResult {...props} />}
  </div>;
}
