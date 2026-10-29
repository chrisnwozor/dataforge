import { buildPivot } from "@/lib/explore/pivot";
import { formatAttribute, formatMeasure } from "@/lib/explore/format";
import type { ChartDatum } from "@/components/charts/types";
import type { AttributeRef, QueryResult, QueryResultColumn, QueryValue } from "@/lib/semantic/query/types";
import type { MeasureFormat, SemanticColumn, SemanticModel } from "@/lib/semantic/types";
import { conditionalStyle } from "./conditional";
import type { ReportColumn, ReportDefinition, ReportFormat, ReportItem, ReportMatrix, ReportParameterValues, ReportTable } from "./schema";
import type { ReportExecutionData, ReportItemData } from "./plan";
export type { ReportExecutionData, ReportItemData } from "./plan";

export const REPORT_ROW_HEIGHT = 22;
export const REPORT_ROW_LIMIT = 100_000;
export const REPORT_PAGE_SIZES = { Letter: [612, 792], A4: [595.28, 841.89], Legal: [612, 1008] } as const;

export interface ReportCell {
  text: string;
  raw: QueryValue;
  width: number;
  align: "left" | "center" | "right";
  format: ReportFormat;
  color?: string;
  bold?: boolean;
  field?: string;
}
interface Geometry { x: number; y: number; width: number; height: number }
export interface ReportTextElement extends Geometry {
  kind: "text"; text: string; fontSize: number; bold?: boolean; color?: string;
  align?: "left" | "center" | "right"; role: "header" | "title" | "group" | "footer" | "body";
}
export interface ReportTableHeaderElement extends Geometry { kind: "tableHeader"; itemId: string; cells: ReportCell[] }
export interface ReportTableRowElement extends Geometry {
  kind: "tableRow"; itemId: string; cells: ReportCell[]; rowKind: "detail" | "subtotal" | "grandTotal";
  level?: number; label?: string;
}
export interface ReportChartElement extends Geometry {
  kind: "chart"; itemId: string; title: string; viz: "bar" | "line" | "area" | "donut";
  data: ChartDatum[]; series: { key: string; label: string; format: MeasureFormat }[];
}
export type ReportElement = ReportTextElement | ReportTableHeaderElement | ReportTableRowElement | ReportChartElement;
export interface ReportPage { number: number; elements: ReportElement[] }
export interface PaginatedReport {
  pages: ReportPage[]; width: number; height: number; rowCount: number; truncated: boolean;
  warnings: string[]; title: string; runAt: string;
}
export interface ReportTabularRow {
  cells: ReportCell[]; rowKind: "detail" | "groupHeader" | "subtotal" | "grandTotal";
  level?: number; label?: string; /** Number of logical lines in a group, for keep-together. */
  keepCount?: number;
}
export interface ReportTabularData { itemId: string; title: string; columns: ReportCell[]; rows: ReportTabularRow[]; keepTogether: boolean; repeatColumns?: number; warnings?: string[] }

const sameRef = (left: AttributeRef, right: AttributeRef) => left.table === right.table && left.column === right.column;
const key = (values: QueryValue[]) => JSON.stringify(values);
function resolveColumn(model: SemanticModel | undefined, ref: AttributeRef): SemanticColumn | undefined {
  const table = model?.tables.find((entry) => entry.id === ref.table || entry.name === ref.table || entry.sqlName === ref.table);
  return table?.columns.find((column) => column.id === ref.column || column.name === ref.column || column.sqlName === ref.column);
}
function measureInfo(model: SemanticModel | undefined, ref: string, fallback?: string) {
  return model?.measures.find((measure) => measure.id === ref || measure.name === ref || measure.name === fallback);
}
function sourceRefs(item: ReportItem, data: ReportItemData): AttributeRef[] {
  if (data.rows) return data.rows;
  if (item.type === "matrix") return [...item.rows, ...item.columns];
  if (!("data" in item)) return [];
  const picked = item.data.kind === "fields" ? item.data.rows : [];
  const refs = item.type === "table" ? [...item.groups, ...picked, ...item.columns.flatMap((column) => column.binding.kind === "attribute" ? [column.binding.attribute] : [])] : picked;
  return refs.filter((ref, index) => refs.findIndex((other) => sameRef(ref, other)) === index);
}
function sourceMeasures(item: ReportItem, data: ReportItemData): string[] {
  return data.measures ?? (item.type === "matrix" ? item.values : "data" in item && item.data.kind === "fields" ? item.data.values : []);
}
function attributeResultColumn(result: QueryResult, refs: AttributeRef[], ref: AttributeRef, model?: SemanticModel): QueryResultColumn | undefined {
  const attrs = result.columns.filter((column) => column.role === "attribute");
  const resolved = resolveColumn(model, ref);
  const index = refs.findIndex((candidate) => sameRef(candidate, ref) || resolved !== undefined && resolveColumn(model, candidate)?.id === resolved.id);
  const name = resolveColumn(model, ref)?.name ?? ref.column;
  return index >= 0 ? attrs[index] : attrs.find((column) => column.name === name);
}
function measureResultColumn(result: QueryResult, refs: string[], ref: string, model?: SemanticModel): QueryResultColumn | undefined {
  const measures = result.columns.filter((column) => column.role === "measure");
  const name = measureInfo(model, ref)?.name ?? ref;
  const named = measures.find((column) => column.name === name);
  const index = refs.indexOf(ref);
  return named ?? (index >= 0 ? measures[index] : undefined);
}
function headerCell(column: ReportColumn): ReportCell {
  return { text: column.label, raw: column.label, width: column.width, align: column.align, format: column.format, bold: true, field: column.binding.kind === "measure" ? column.binding.measure : column.binding.attribute.column };
}
function tableData(item: ReportTable, data: ReportItemData, model?: SemanticModel): ReportTabularData {
  const refs = sourceRefs(item, data), measureRefs = sourceMeasures(item, data);
  const columns = item.columns.map(headerCell);
  const groupedColumns = item.groups.map((ref) => attributeResultColumn(data.result, refs, ref, model));
  const descriptors = item.columns.map((column) => {
    const binding = column.binding;
    const resultColumn = binding.kind === "attribute" ? attributeResultColumn(data.result, refs, binding.attribute, model) : measureResultColumn(data.result, measureRefs, binding.measure, model);
    const format = column.format === "auto" && binding.kind === "measure" ? measureInfo(model, binding.measure, resultColumn?.name)?.format ?? "number" : column.format;
    return { column, resultColumn, format };
  });
  const detailCells = (row: Record<string, QueryValue>) => descriptors.map(({ column, resultColumn, format }): ReportCell => {
    const raw = resultColumn ? row[resultColumn.key] ?? null : null;
    const binding = column.binding;
    const text = binding.kind === "attribute" ? formatAttribute(raw, resolveColumn(model, binding.attribute) ?? resultColumn) : formatMeasure(raw, format);
    return { text, raw, width: column.width, align: column.align, format, field: binding.kind === "measure" ? binding.measure : binding.attribute.column,
      ...(binding.kind === "measure" ? conditionalStyle(raw, binding.measure, item.conditionalFormats) : {}) };
  });
  const totals = new Map<string, Map<string, Record<string, QueryValue>>>();
  for (const total of data.totals ?? []) {
    if (total.result.truncated) continue;
    const attrs = total.result.columns.filter((column) => column.role === "attribute");
    const records = new Map<string, Record<string, QueryValue>>();
    for (const row of total.result.rows) records.set(key(attrs.map((column) => row[column.key] ?? null)), row);
    totals.set(JSON.stringify(total.groupBy), records);
  }
  const totalCells = (groupBy: AttributeRef[], values: QueryValue[], label: string): ReportCell[] => {
    const entry = data.totals?.find((total) => JSON.stringify(total.groupBy) === JSON.stringify(groupBy));
    const row = totals.get(JSON.stringify(groupBy))?.get(key(values));
    let labeled = false;
    return descriptors.map(({ column, format }): ReportCell => {
      const binding = column.binding;
      if (binding.kind === "attribute") {
        const text = !labeled ? label : ""; labeled = true;
        return { text, raw: text, width: column.width, align: column.align, format: column.format, bold: true, field: binding.attribute.column };
      }
      const source = entry ? measureResultColumn(entry.result, measureRefs, binding.measure, model) : undefined;
      const raw = row && source ? row[source.key] ?? null : null;
      return { text: formatMeasure(raw, format), raw, width: column.width, align: column.align, format, bold: true, field: binding.measure, ...conditionalStyle(raw, binding.measure, item.conditionalFormats) };
    });
  };
  const rows: ReportTabularRow[] = [];
  const append = (records: Record<string, QueryValue>[], level: number, values: QueryValue[]) => {
    if (level === item.groups.length) { for (const row of records) rows.push({ cells: detailCells(row), rowKind: "detail" }); return; }
    const grouped = new Map<string, { value: QueryValue; records: Record<string, QueryValue>[] }>();
    const column = groupedColumns[level];
    for (const row of records) {
      const value = column ? row[column.key] ?? null : null;
      const member = grouped.get(key([value])) ?? { value, records: [] };
      member.records.push(row); grouped.set(key([value]), member);
    }
    for (const group of grouped.values()) {
      const ref = item.groups[level], path = [...values, group.value];
      const attributeName = resolveColumn(model, ref)?.name ?? column?.name ?? ref.column;
      const label = `${attributeName}: ${formatAttribute(group.value, resolveColumn(model, ref) ?? column)}`;
      const start = rows.length;
      rows.push({ rowKind: "groupHeader", cells: [], label, level });
      append(group.records, level + 1, path);
      if (item.subtotals) rows.push({ rowKind: "subtotal", cells: totalCells(item.groups.slice(0, level + 1), path, `${label} subtotal`), label: `${label} subtotal`, level });
      rows[start].keepCount = rows.length - start;
    }
  };
  let records = data.result.rows;
  if (item.topNPerGroup) {
    const top = item.topNPerGroup;
    const metric = measureResultColumn(data.result, measureRefs, top.measure, model);
    const groups = new Map<string, Record<string, QueryValue>[]>();
    for (const record of records) {
      const groupKey = key(groupedColumns.map((column) => column ? record[column.key] ?? null : null));
      const members = groups.get(groupKey) ?? []; members.push(record); groups.set(groupKey, members);
    }
    const score = (row: Record<string, QueryValue>) => {
      const raw = metric ? row[metric.key] : null;
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      return Number.isFinite(value) ? value : -Infinity;
    };
    records = [...groups.values()].flatMap((members) => members.map((record, ordinal) => ({ record, ordinal })).sort((left, right) => score(right.record) - score(left.record) || left.ordinal - right.ordinal).slice(0, top.n).map(({ record }) => record));
  }
  append(records, 0, []);
  if (item.grandTotal && data.result.rows.length) rows.push({ rowKind: "grandTotal", cells: totalCells([], [], "Grand total"), label: "Grand total" });
  return { itemId: item.id, title: item.title, columns, rows, keepTogether: item.keepTogether };
}

function matrixData(item: ReportMatrix, data: ReportItemData, model?: SemanticModel): ReportTabularData {
  const totalAt = (groupBy: AttributeRef[]) => data.totals?.find((total) => JSON.stringify(total.groupBy) === JSON.stringify(groupBy))?.result;
  const pivot = buildPivot(data.result, { rows: item.rows, columns: item.columns }, { rows: totalAt(item.rows), columns: totalAt(item.columns), grand: totalAt([]) });
  const rowCols = item.rows.map((ref): ReportCell => ({ text: resolveColumn(model, ref)?.name ?? ref.column, raw: resolveColumn(model, ref)?.name ?? ref.column, width: 100, align: "left", format: "auto", field: ref.column }));
  const descriptors = pivot.columns.flatMap((member) => pivot.measureColumns.map((measure, index) => ({ member, measure, index })));
  const measureRefs = sourceMeasures(item, data);
  const format = (index: number): MeasureFormat => measureInfo(model, item.values[index] ?? measureRefs[index], pivot.measureColumns[index]?.name)?.format ?? "number";
  const columns = [...rowCols, ...descriptors.map(({ member, measure, index }): ReportCell => {
    const name = `${member.members.map((value, ordinal) => formatAttribute(value, resolveColumn(model, item.columns[ordinal]))).join(" / ")} · ${measure.name}`;
    return { text: name, raw: name, width: 90, align: "right", format: format(index), field: item.values[index] ?? measure.name };
  }), ...(item.grandTotal ? pivot.measureColumns.map((measure, index): ReportCell => ({ text: `Total · ${measure.name}`, raw: `Total · ${measure.name}`, width: 90, align: "right", format: format(index), field: item.values[index] ?? measure.name })) : [])];
  const valueCell = (value: QueryValue | undefined, index: number, bold = false): ReportCell => ({ text: formatMeasure(value, format(index)), raw: value ?? null, width: 90, align: "right", format: format(index), bold, field: item.values[index] ?? pivot.measureColumns[index].name, ...conditionalStyle(value, item.values[index] ?? pivot.measureColumns[index].name, item.conditionalFormats) });
  const detail = (row: typeof pivot.rows[number]): ReportTabularRow => ({ rowKind: "detail", cells: [
    ...row.members.map((value, index): ReportCell => ({ ...rowCols[index], text: formatAttribute(value, resolveColumn(model, item.rows[index])), raw: value })),
    ...descriptors.map(({ member, index }) => valueCell(row.values[member.key]?.[index], index)),
    ...(item.grandTotal ? pivot.measureColumns.map((_, index) => valueCell(row.total[index], index)) : []),
  ] });
  const rows: ReportTabularRow[] = [];
  const subtotal = (prefix: AttributeRef[], values: QueryValue[], label: string, level: number): ReportTabularRow => {
    const source = totalAt([...prefix, ...item.columns]);
    const at = totalAt(prefix);
    const records = new Map<string, Record<string, QueryValue>>();
    if (source && !source.truncated) {
      const attrs = source.columns.filter((column) => column.role === "attribute");
      for (const row of source.rows) {
        if (attrs.slice(0, prefix.length).every((column, index) => Object.is(row[column.key] ?? null, values[index]))) records.set(key(attrs.slice(prefix.length).map((column) => row[column.key] ?? null)), row);
      }
    }
    const atAttrs = at?.columns.filter((column) => column.role === "attribute") ?? [];
    const rowTotal = at && !at.truncated ? at.rows.find((row) => atAttrs.every((column, index) => Object.is(row[column.key] ?? null, values[index]))) : undefined;
    const read = (result: QueryResult | undefined, row: Record<string, QueryValue> | undefined, index: number) => {
      const column = result ? measureResultColumn(result, measureRefs, item.values[index] ?? measureRefs[index], model) : undefined;
      return column && row ? row[column.key] ?? null : null;
    };
    return { rowKind: "subtotal", label, level, cells: [
      ...rowCols.map((column, index): ReportCell => ({ ...column, text: index === 0 ? label : "", raw: index === 0 ? label : "", bold: true })),
      ...descriptors.map(({ member, index }) => valueCell(read(source, records.get(member.key), index), index, true)),
      ...(item.grandTotal ? pivot.measureColumns.map((_, index) => valueCell(read(at, rowTotal, index), index, true)) : []),
    ] };
  };
  const append = (members: typeof pivot.rows, level: number, path: QueryValue[]) => {
    if (level >= item.rows.length - 1) { rows.push(...members.map(detail)); return; }
    const grouped = new Map<string, { value: QueryValue; rows: typeof pivot.rows }>();
    for (const row of members) {
      const value = row.members[level], group = grouped.get(key([value])) ?? { value, rows: [] };
      group.rows.push(row); grouped.set(key([value]), group);
    }
    for (const group of grouped.values()) {
      const ref = item.rows[level], values = [...path, group.value];
      const label = `${resolveColumn(model, ref)?.name ?? ref.column}: ${formatAttribute(group.value, resolveColumn(model, ref))}`;
      const start = rows.length;
      rows.push({ rowKind: "groupHeader", cells: [], label, level });
      append(group.rows, level + 1, values);
      if (item.subtotals) rows.push(subtotal(item.rows.slice(0, level + 1), values, `${label} subtotal`, level));
      rows[start].keepCount = rows.length - start;
    }
  };
  append(pivot.rows, 0, []);
  if (item.grandTotal && rows.length) rows.push({ rowKind: "grandTotal", label: "Grand total", cells: [
    ...rowCols.map((column, index) => ({ ...column, text: index === 0 ? "Grand total" : "", raw: index === 0 ? "Grand total" : "", bold: true })),
    ...descriptors.map(({ member, index }) => valueCell(pivot.columnTotals[member.key]?.[index], index, true)),
    ...pivot.measureColumns.map((_, index) => valueCell(pivot.grandTotal[index], index, true)),
  ] });
  return { itemId: item.id, title: item.title, columns, rows, keepTogether: item.keepTogether, repeatColumns: item.rows.length, warnings: pivot.truncatedColumns ? ["Matrix column members are limited to 50. Narrow its filters for additional members."] : [] };
}

/** Apply the same source-row budget before pagination, PDF, Excel and CSV. */
export function capReportData(definition: ReportDefinition, input: ReportExecutionData): ReportExecutionData {
  let remaining = REPORT_ROW_LIMIT;
  const items: Record<string, ReportItemData> = {};
  for (const item of definition.items) {
    const source = input.items[item.id]; if (!source) continue;
    const length = Math.min(source.result.rows.length, remaining);
    items[item.id] = { ...source, result: { ...source.result, rows: source.result.rows.slice(0, length), rowCount: length, truncated: source.result.truncated || length < source.result.rows.length } };
    remaining -= length;
  }
  return { ...input, items };
}

/** Export tabular data retains raw numbers and obtains all totals from server query results. */
export function reportTabularRows(definition: ReportDefinition, data: ReportExecutionData, model?: SemanticModel): ReportTabularData[] {
  return definition.items.flatMap((item) => {
    const source = data.items[item.id];
    if (!source || (item.type !== "table" && item.type !== "matrix") || item.hideOnEmpty && !source.result.rows.length) return [];
    return [item.type === "table" ? tableData(item, source, model) : matrixData(item, source, model)];
  });
}

/** Predictable wrapping is shared by preview and export; no browser measurement participates. */
export function wrapReportText(text: string, width: number, fontSize = 10): string[] {
  const capacity = Math.max(1, Math.floor(width / (fontSize * 0.56) + 1e-9));
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!paragraph) { lines.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + 1 + word.length > capacity) { lines.push(line); line = ""; }
      let remainder = word;
      while (remainder.length > capacity) { if (line) { lines.push(line); line = ""; } lines.push(remainder.slice(0, capacity)); remainder = remainder.slice(capacity); }
      if (remainder) line = line ? `${line} ${remainder}` : remainder;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

function parameterLabels(definition: ReportDefinition, values: ReportParameterValues): string[] {
  return definition.parameters.map((parameter) => {
    const value = values[parameter.id];
    const text = value === null || value === undefined ? "All" : Array.isArray(value) ? value.map((item) => formatAttribute(item)).join(", ") : typeof value === "object" ? `${formatAttribute(value.from)} – ${formatAttribute(value.to)}` : formatAttribute(value);
    return `${parameter.name}: ${text}`;
  });
}

/** A pure fixed-row layout. Every coordinate is in points from the page's top-left. */
export function paginateReport(definition: ReportDefinition, input: ReportExecutionData, model?: SemanticModel, reportName = "Report"): PaginatedReport {
  const dimensions = REPORT_PAGE_SIZES[definition.page.size];
  const [width, height] = definition.page.orientation === "landscape" ? [dimensions[1], dimensions[0]] : dimensions;
  const { margins } = definition.page;
  const bodyWidth = width - margins.left - margins.right;
  const title = definition.header.title || reportName;
  const warnings = new Set<string>();
  let rowCount = 0, truncated = false;
  const data = capReportData(definition, input);
  for (const item of definition.items) {
    const source = data.items[item.id]; if (!source) continue;
    if (source.result.truncated) { truncated = true; warnings.add("Report reached the 100,000-row cap or the source query limit. Narrow its parameters for complete results."); }
    rowCount += source.result.rows.length;
    if (source.totals?.some((total) => total.result.truncated)) warnings.add("Some server totals were truncated and are shown as an em dash.");
    if (item.type === "matrix" && source.result.pivot && source.result.truncated) warnings.add("Matrix column members are limited to 50. Narrow its filters for additional members.");
    if (item.type === "table" && item.topNPerGroup) warnings.add("Top N is applied within each group. Server subtotals and grand totals include all filtered members before Top N.");
  }
  const tabular = new Map(reportTabularRows(definition, data, model).map((item) => [item.itemId, item]));
  for (const item of tabular.values()) item.warnings?.forEach((warning) => warnings.add(warning));
  const headerLines = [title, definition.header.subtitle, definition.header.text,
    ...(definition.header.showRunDate ? [`Run: ${input.runAt}`] : []),
    ...(definition.header.showParameters ? parameterLabels(definition, input.parameters) : []),
  ].filter(Boolean).flatMap((text, index) => wrapReportText(text, bodyWidth, index === 0 ? 16 : 9));
  const visibleHeader = headerLines.slice(0, 10);
  if (headerLines.length > visibleHeader.length) warnings.add("The report header was shortened to 10 lines; shorten its text or parameter selections.");
  const headerHeight = visibleHeader.length ? 24 + Math.max(0, visibleHeader.length - 1) * 13 + 12 : 0;
  const footerHeight = definition.footer.text || definition.footer.showPageNumbers ? 26 : 0;
  const top = margins.top + headerHeight, bottom = height - margins.bottom - footerHeight;
  const bodyHeight = bottom - top;
  const pages: ReportPage[] = [];
  let page!: ReportPage;
  let y = top;
  const newPage = () => {
    page = { number: pages.length + 1, elements: [] }; pages.push(page); y = top;
    let headerY = margins.top;
    visibleHeader.forEach((text, index) => { const size = index === 0 ? 16 : 9; page.elements.push({ kind: "text", x: margins.left, y: headerY, width: bodyWidth, height: index === 0 ? 24 : 13, text, fontSize: size, bold: index === 0, role: "header" }); headerY += index === 0 ? 24 : 13; });
  };
  newPage();
  const ensure = (needed: number) => { if (y + needed > bottom && y > top) newPage(); };
  const addText = (text: string, role: ReportTextElement["role"], fontSize = 10, bold = false, indent = 0) => {
    const lines = wrapReportText(text, bodyWidth - indent, fontSize);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if ((index === 0 && lines.length > 1 || lines.length - index === 2) && y > top && bottom - y < (fontSize + 5) * 2) newPage();
      ensure(fontSize + 5); page.elements.push({ kind: "text", x: margins.left + indent, y, width: bodyWidth - indent, height: fontSize + 5, text: line, fontSize, bold, role }); y += fontSize + 5;
    }
  };
  const tableBand = (item: ReportTabularData) => {
    if (item.title) {
      const titleHeight = wrapReportText(item.title, bodyWidth, 12).length * 17 + 7;
      ensure(titleHeight + REPORT_ROW_HEIGHT * (item.rows[0]?.rowKind === "groupHeader" ? 4 : 3));
      addText(item.title, "title", 12, true); y += 7;
    }
    const totalWidth = item.columns.reduce((sum, column) => sum + column.width, 0);
    const widths = item.columns.map((column) => column.width / totalWidth * bodyWidth);
    const fitted = (cells: ReportCell[]) => cells.map((cell, index) => ({ ...cell, width: widths[index] ?? 0 }));
    const header = () => { ensure(REPORT_ROW_HEIGHT * 2); page.elements.push({ kind: "tableHeader", itemId: item.itemId, x: margins.left, y, width: bodyWidth, height: REPORT_ROW_HEIGHT, cells: fitted(item.columns) }); y += REPORT_ROW_HEIGHT; };
    const tablePage = () => { newPage(); header(); };
    header();
    if (!item.rows.length) { ensure(REPORT_ROW_HEIGHT); addText("No rows match the report parameters.", "body"); y += 10; return; }
    for (let index = 0; index < item.rows.length; index++) {
      const row = item.rows[index];
      const room = Math.floor((bottom - y) / REPORT_ROW_HEIGHT);
      if (row.rowKind === "groupHeader") {
        const fullHeight = (row.keepCount ?? 1) * REPORT_ROW_HEIGHT;
        const enoughOnNewPage = fullHeight <= bodyHeight - REPORT_ROW_HEIGHT;
        if (item.keepTogether && enoughOnNewPage && fullHeight > bottom - y || room < Math.min(3, row.keepCount ?? 2)) tablePage();
      } else if (row.rowKind === "detail") {
        // Keep the final detail rows with their closing subtotal/grand-total
        // chain, so a page never starts with an otherwise orphaned summary.
        const detailCount = item.rows[index + 1]?.rowKind === "detail" && item.rows[index + 2]?.rowKind !== "detail" ? 2 : 1;
        let tailEnd = index + detailCount;
        while (item.rows[tailEnd]?.rowKind === "subtotal" || item.rows[tailEnd]?.rowKind === "grandTotal") tailEnd++;
        const needed = tailEnd - index;
        const pageCapacity = Math.floor((bodyHeight - REPORT_ROW_HEIGHT) / REPORT_ROW_HEIGHT);
        if (room < 1 || needed <= pageCapacity && needed > room) tablePage();
      }
      else if (room < 1) tablePage();
      if (row.rowKind === "groupHeader") page.elements.push({ kind: "text", role: "group", x: margins.left + (row.level ?? 0) * 10, y, width: bodyWidth - (row.level ?? 0) * 10, height: REPORT_ROW_HEIGHT, text: row.label ?? "", fontSize: 10, bold: true });
      else page.elements.push({ kind: "tableRow", itemId: item.itemId, x: margins.left, y, width: bodyWidth, height: REPORT_ROW_HEIGHT, cells: fitted(row.cells), rowKind: row.rowKind, level: row.level, label: row.label });
      y += REPORT_ROW_HEIGHT;
    }
    y += 15;
  };
  const table = (item: ReportTabularData) => {
    const repeat = item.repeatColumns;
    const totalWidth = item.columns.reduce((sum, column) => sum + column.width, 0);
    if (!repeat || totalWidth <= bodyWidth || repeat >= item.columns.length) { tableBand(item); return; }
    // Wide matrices continue horizontally on subsequent pages, repeating their
    // row labels rather than shrinking dozens of columns into unreadable slivers.
    const fixed = item.columns.slice(0, repeat).reduce((sum, column) => sum + column.width, 0);
    const groups: number[][] = [];
    let group: number[] = [], used = fixed;
    for (let index = repeat; index < item.columns.length; index++) {
      const width = item.columns[index].width;
      if (group.length && used + width > bodyWidth) { groups.push(group); group = []; used = fixed; }
      group.push(index); used += width;
    }
    if (group.length) groups.push(group);
    if (groups.length <= 1) { tableBand(item); return; }
    warnings.add(`Wide matrix “${item.title || item.itemId}” continues in ${groups.length} horizontal column bands with repeated row labels.`);
    groups.forEach((indices, index) => {
      if (index && y > top) newPage();
      const visible = [...Array.from({ length: repeat }, (_, ordinal) => ordinal), ...indices];
      tableBand({ ...item, title: `${item.title || "Matrix"} · part ${index + 1} of ${groups.length}`, columns: visible.map((ordinal) => item.columns[ordinal]), rows: item.rows.map((row) => ({ ...row, cells: row.rowKind === "groupHeader" ? [] : visible.map((ordinal) => row.cells[ordinal]) })) });
    });
  };
  for (let index = 0; index < definition.items.length; index++) {
    const item = definition.items[index];
    if (item.type === "pageBreak") {
      // Consecutive/trailing breaks never create empty output pages.
      if (y > top && definition.items.slice(index + 1).some((candidate) => candidate.type !== "pageBreak")) newPage();
      continue;
    }
    if (item.type === "text") { if (item.title) addText(item.title, "title", 12, true); addText(item.content, "body"); y += 12; continue; }
    const source = data.items[item.id];
    if (!source) { addText(`${item.title || "Report item"}: data is unavailable.`, "body"); continue; }
    if ((item.type === "table" || item.type === "matrix") && item.hideOnEmpty && !source.result.rows.length) continue;
    if (item.type === "table" || item.type === "matrix") { const output = tabular.get(item.id); if (output) table(output); continue; }
    const chartHeight = Math.min(item.height, bodyHeight);
    ensure(chartHeight + 10);
    const attrs = source.result.columns.filter((column) => column.role === "attribute");
    const measures = source.result.columns.filter((column) => column.role === "measure");
    const refs = sourceMeasures(item, source), rowRefs = sourceRefs(item, source);
    const limit = item.viz === "donut" ? 50 : 200;
    if (source.result.rows.length > limit) warnings.add(`Chart “${item.title || item.id}” shows its first ${limit} categories; tabular exports preserve the query result.`);
    const chartData: ChartDatum[] = source.result.rows.slice(0, limit).map((row, ordinal) => ({ key: String(ordinal), label: attrs.map((column, attributeIndex) => formatAttribute(row[column.key], resolveColumn(model, rowRefs[attributeIndex] ?? { table: "", column: column.name }) ?? column)).join(" / ") || "All data", values: Object.fromEntries(measures.map((column) => {
      const raw = row[column.key], value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      return [column.key, Number.isFinite(value) ? value : null];
    })) }));
    page.elements.push({ kind: "chart", itemId: item.id, title: item.title, viz: item.viz, x: margins.left, y, width: bodyWidth, height: chartHeight, data: chartData, series: measures.map((column, ordinal) => ({ key: column.key, label: column.name, format: measureInfo(model, refs[ordinal] ?? column.name, column.name)?.format ?? "number" })) });
    y += chartHeight + 15;
  }
  for (const output of pages) {
    if (definition.footer.text) {
      const footerWidth = definition.footer.showPageNumbers ? bodyWidth * 0.7 : bodyWidth;
      const lines = wrapReportText(definition.footer.text, footerWidth, 9);
      if (lines.length > 2) warnings.add("The custom footer was shortened to two lines.");
      lines.slice(0, 2).forEach((text, index) => output.elements.push({ kind: "text", role: "footer", x: margins.left, y: height - margins.bottom - 24 + index * 12, width: footerWidth, height: 12, text, fontSize: 9 }));
    }
    if (definition.footer.showPageNumbers) output.elements.push({ kind: "text", role: "footer", x: margins.left, y: height - margins.bottom - 17, width: bodyWidth, height: 14, text: `Page ${output.number} of ${pages.length}`, fontSize: 9, align: "right" });
  }
  return { pages, width, height, rowCount, truncated, warnings: [...warnings], title, runAt: input.runAt };
}
