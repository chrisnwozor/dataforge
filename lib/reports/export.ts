import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToNode } from "node:timers/promises";
import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as XLSX from "xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { csvCell } from "@/lib/explore/csv";
import { formatMeasure } from "@/lib/explore/format";
import { donutArc, linearScale, niceTicks, numericDomain } from "@/components/charts/scales";
import type { SemanticModel } from "@/lib/semantic/types";
import type { ReportDefinition, ReportFormat } from "./schema";
import { capReportData, paginateReport, reportTabularRows, type ReportCell, type ReportElement, type ReportExecutionData, type ReportTabularData, type ReportTabularRow } from "./pagination";

export type ReportExportFormat = "pdf" | "xlsx" | "csv";
export interface ReportExportInput {
  definition: ReportDefinition;
  data: ReportExecutionData;
  model?: SemanticModel;
  name?: string;
  signal?: AbortSignal;
}

function checkExportAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The report export was cancelled.", "AbortError");
}

const ink = rgb(0.08, 0.1, 0.13);
const lineColor = rgb(0.85, 0.87, 0.9);
const palette = ["#2563eb", "#334155", "#64748b", "#94a3b8", "#0f766e", "#9333ea", "#c2410c", "#be185d", "#15803d", "#6d28d9", "#0e7490", "#a16207"];
const hexColor = (color: string) => /^#[0-9a-f]{6}$/i.test(color)
  ? rgb(parseInt(color.slice(1, 3), 16) / 255, parseInt(color.slice(3, 5), 16) / 255, parseInt(color.slice(5, 7), 16) / 255) : ink;

let fontBytes: Promise<{ normal: Uint8Array; bold: Uint8Array }> | undefined;
async function loadFontBytes() {
  return fontBytes ??= (async () => {
    // Read the bundled assets directly: resolving Geist's JS entry also pulls
    // next/font CSS into instrumentation, where Next cannot evaluate it.
    // next.config.ts explicitly traces these fonts for packaged deployments.
    const directory = join(process.cwd(), "node_modules", "geist", "dist", "fonts", "geist-sans");
    const [normal, bold] = await Promise.all([readFile(join(directory, "Geist-Regular.ttf")), readFile(join(directory, "Geist-Bold.ttf"))]);
    return { normal, bold };
  })().catch((error: unknown) => { fontBytes = undefined; throw error; });
}

interface PdfFonts { normal: PDFFont; bold: PDFFont; characters: Set<number> }
function supportedText(text: string, fonts: PdfFonts): string {
  // The embedded font preserves its supported Unicode characters. Unsupported
  // glyphs use a visible replacement rather than silently disappearing or
  // making the entire export fail (e.g. an emoji in a customer name).
  return [...text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")].map((character) => character === "\n" || character === "\r" || fonts.characters.has(character.codePointAt(0)!) ? character : "?").join("");
}

function fitText(text: string, width: number, font: PDFFont, size: number): string {
  if (width <= 0) return "";
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  const chars = [...text];
  let lower = 0, upper = chars.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (font.widthOfTextAtSize(`${chars.slice(0, middle).join("")}…`, size) <= width) lower = middle;
    else upper = middle - 1;
  }
  return lower || font.widthOfTextAtSize("…", size) <= width ? `${chars.slice(0, lower).join("")}…` : "";
}

function drawText(page: PDFPage, fonts: PdfFonts, text: string, x: number, top: number, width: number, options: { size?: number; bold?: boolean; color?: string; align?: "left" | "center" | "right" } = {}) {
  const font = options.bold ? fonts.bold : fonts.normal;
  const size = options.size ?? 9;
  const safe = fitText(supportedText(text.replace(/[\r\n]+/g, " "), fonts), width, font, size);
  if (!safe) return;
  const actualWidth = font.widthOfTextAtSize(safe, size);
  const offset = options.align === "right" ? width - actualWidth : options.align === "center" ? (width - actualWidth) / 2 : 0;
  page.drawText(safe, { x: x + Math.max(0, offset), y: page.getHeight() - top - size, size, font, color: options.color ? hexColor(options.color) : ink });
}

function drawCells(page: PDFPage, fonts: PdfFonts, element: Extract<ReportElement, { kind: "tableHeader" | "tableRow" }>) {
  const header = element.kind === "tableHeader";
  const total = element.kind === "tableRow" && element.rowKind !== "detail";
  if (header || total) page.drawRectangle({ x: element.x, y: page.getHeight() - element.y - element.height, width: element.width, height: element.height, color: header ? rgb(0.93, 0.95, 0.97) : rgb(0.97, 0.98, 0.99) });
  let x = element.x;
  for (const cell of element.cells) {
    drawText(page, fonts, cell.text, x + 5, element.y + 6, Math.max(0, cell.width - 10), { size: 8.5, align: cell.align, bold: header || total || cell.bold, color: cell.color });
    x += cell.width;
  }
  page.drawLine({ start: { x: element.x, y: page.getHeight() - element.y - element.height }, end: { x: element.x + element.width, y: page.getHeight() - element.y - element.height }, thickness: 0.4, color: lineColor });
}

function drawChart(page: PDFPage, fonts: PdfFonts, element: Extract<ReportElement, { kind: "chart" }>) {
  if (element.title) drawText(page, fonts, element.title, element.x, element.y, element.width, { size: 10, bold: true });
  const data = element.data.slice(0, element.viz === "donut" ? 50 : 200);
  const series = element.series.slice(0, 12);
  if (!data.length || !series.length) { drawText(page, fonts, "No chart data", element.x, element.y + 12, element.width); return; }
  const top = element.y + 16;
  const left = element.x + 52, right = element.x + element.width - 12;
  const clipped = element.data.length > data.length;
  const bottom = element.y + element.height - 32 - (series.length > 1 && element.viz !== "donut" ? 16 : 0) - (clipped ? 12 : 0);
  const chartWidth = Math.max(1, right - left), chartHeight = Math.max(1, bottom - top);
  const pageY = (y: number) => page.getHeight() - y;
  if (element.viz === "donut") {
    const values = data.map((row) => Math.max(0, row.values[series[0].key] ?? 0));
    const sum = values.reduce((value, next) => value + next, 0);
    const maximum = Math.max(0, ...values);
    if (!maximum) { drawText(page, fonts, "No positive values", element.x, top, element.width); return; }
    const weights = values.map((value) => value / maximum);
    const weightTotal = weights.reduce((total, value) => total + value, 0);
    const radius = Math.max(10, Math.min(chartHeight / 2, chartWidth * 0.26));
    const cx = element.x + element.width * 0.33, cy = top + chartHeight / 2;
    let angle = -Math.PI / 2;
    values.forEach((value, index) => {
      const start = angle, sweep = weights[index] / weightTotal * Math.PI * 2;
      angle += sweep;
      if (!value) return;
      // The shared SVG chart's arc geometry remains a vector PDF path.
      page.drawSvgPath(donutArc(start, angle, radius, radius * 0.6), { x: cx, y: pageY(cy), color: hexColor(palette[index % palette.length]) });
    });
    drawText(page, fonts, formatMeasure(sum, series[0].format), cx - radius * 0.52, cy - 5, radius * 1.04, { size: 9, bold: true, align: "center" });
    data.slice(0, 8).forEach((row, index) => {
      const y = top + 8 + index * 17;
      page.drawRectangle({ x: element.x + element.width * 0.65, y: pageY(y + 7), width: 7, height: 7, color: hexColor(palette[index % palette.length]) });
      drawText(page, fonts, row.label, element.x + element.width * 0.65 + 12, y, element.width * 0.35 - 16, { size: 8 });
    });
    if (clipped) drawText(page, fonts, `Chart shows the first ${data.length} categories.`, element.x, element.y + element.height - 9, element.width, { size: 7 });
    return;
  }
  const finite = data.flatMap((row) => series.map((entry) => row.values[entry.key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  if (!finite.length) { drawText(page, fonts, "No numeric values", element.x, top, element.width); return; }
  const domain = numericDomain(finite);
  const ticks = niceTicks(domain[0], domain[1], 5);
  const y = linearScale([ticks[0], ticks[ticks.length - 1]], [bottom, top]);
  const band = chartWidth / data.length;
  const x = (index: number) => left + (index + 0.5) * band;
  for (const value of ticks) {
    const ordinate = y(value);
    page.drawLine({ start: { x: left, y: pageY(ordinate) }, end: { x: right, y: pageY(ordinate) }, thickness: 0.3, color: lineColor });
    drawText(page, fonts, formatMeasure(value, series[0].format), element.x, ordinate - 4, 45, { size: 7.5, align: "right" });
  }
  series.forEach((entry, ordinal) => {
    const color = hexColor(palette[ordinal % palette.length]);
    if (element.viz === "bar") {
      const width = Math.max(0.05, band * 0.75 / series.length);
      data.forEach((row, index) => {
        const value = row.values[entry.key];
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        const baseline = y(0), ordinate = y(value);
        page.drawRectangle({ x: x(index) - band * 0.375 + width * ordinal, y: pageY(Math.max(baseline, ordinate)), width, height: Math.abs(ordinate - baseline), color });
      });
    } else {
      let path = "", firstX = 0, lastX = 0;
      const flush = () => {
        if (!path) return;
        if (element.viz === "area") page.drawSvgPath(`${path} L ${lastX} ${y(0)} L ${firstX} ${y(0)} Z`, { x: 0, y: page.getHeight(), color, opacity: 0.16 });
        page.drawSvgPath(path, { x: 0, y: page.getHeight(), borderColor: color, borderWidth: 1.3 });
        path = "";
      };
      data.forEach((row, index) => {
        const value = row.values[entry.key];
        if (typeof value !== "number" || !Number.isFinite(value)) { flush(); return; }
        if (!path) firstX = x(index);
        lastX = x(index); path += `${path ? " L" : "M"} ${lastX} ${y(value)}`;
        page.drawCircle({ x: lastX, y: pageY(y(value)), size: 1.3, color });
      });
      flush();
    }
  });
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(chartWidth / 75))));
  data.forEach((row, index) => { if (index % every === 0) drawText(page, fonts, row.label, x(index) - Math.min(40, band / 2), bottom + 9, Math.min(80, band * every), { size: 7.5, align: "center" }); });
  if (series.length > 1) series.forEach((entry, index) => {
    const width = element.width / series.length;
    const x = element.x + width * index;
    const top = element.y + element.height - 14 - (clipped ? 12 : 0);
    page.drawRectangle({ x, y: pageY(top + 7), width: 6, height: 6, color: hexColor(palette[index % palette.length]) });
    drawText(page, fonts, entry.label, x + 10, top, width - 14, { size: 7 });
  });
  if (element.data.length > data.length) drawText(page, fonts, `Chart shows the first ${data.length} categories.`, element.x, element.y + element.height - 9, element.width, { size: 7 });
}

/** The PDF uses the same page geometry and rows as the preview, with embedded text and vector marks. */
export async function generateReportPdf(definition: ReportDefinition, data: ReportExecutionData, model?: SemanticModel, reportName?: string, signal?: AbortSignal): Promise<Uint8Array> {
  checkExportAbort(signal);
  const layout = paginateReport(definition, data, model, reportName);
  checkExportAbort(signal);
  const pdf = await PDFDocument.create();
  pdf.setTitle(layout.title);
  pdf.setCreator("DataForge");
  pdf.setProducer("DataForge paginated reports");
  if (Number.isFinite(Date.parse(data.runAt))) pdf.setCreationDate(new Date(data.runAt));
  pdf.registerFontkit(fontkit);
  const bytes = await loadFontBytes();
  const normal = await pdf.embedFont(bytes.normal, { subset: true });
  const bold = await pdf.embedFont(bytes.bold, { subset: true });
  const fonts: PdfFonts = { normal, bold, characters: new Set(normal.getCharacterSet()) };
  checkExportAbort(signal);
  for (const [index, source] of layout.pages.entries()) {
    // Let HTTP cancel/navigation handlers run between bounded chunks of pages.
    // A microtask-only yield would still starve Node's network event callbacks.
    if (index > 0 && index % 8 === 0) await yieldToNode();
    checkExportAbort(signal);
    const page = pdf.addPage([layout.width, layout.height]);
    for (const element of source.elements) {
      if (element.kind === "text") drawText(page, fonts, element.text, element.x, element.y, element.width, { size: element.fontSize, bold: element.bold, color: element.color, align: element.align });
      else if (element.kind === "tableHeader" || element.kind === "tableRow") drawCells(page, fonts, element);
      else if (element.kind === "chart") drawChart(page, fonts, element);
    }
  }
  checkExportAbort(signal);
  const output = await pdf.save();
  checkExportAbort(signal);
  return output;
}

const excelNumberFormat = (format: ReportFormat): string => format === "currency" ? '"$"#,##0.00;[Red]-"$"#,##0.00' : format === "percent" ? "0.00%" : format === "decimals" ? "#,##0.00" : "#,##0.##";
const invalidSheetCharacters = /[\\/?*\[\]:\u0000-\u001f]/g;
export function reportSheetName(input: string, used: Set<string>): string {
  const base = input.replace(invalidSheetCharacters, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Table";
  let candidate = base, suffix = 1;
  while ([...used].some((name) => name.toLowerCase() === candidate.toLowerCase())) {
    const tail = ` (${++suffix})`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
  }
  used.add(candidate); return candidate;
}

function excelCell(cell: ReportCell): XLSX.CellObject {
  if (cell.raw === null || cell.raw === undefined) return { t: "z", v: undefined };
  if (typeof cell.raw === "number" && Number.isFinite(cell.raw)) return { t: "n", v: cell.raw, z: excelNumberFormat(cell.format) };
  if (typeof cell.raw === "boolean") return { t: "b", v: cell.raw };
  if (cell.format !== "auto" && typeof cell.raw === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(cell.raw)) {
    const value = Number(cell.raw);
    const significant = cell.raw.replace(/^[+-]?0*|[.eE+-]/g, "").replace(/0+$/, "");
    if (Number.isFinite(value) && significant.length <= 15 && (!Number.isInteger(value) || Number.isSafeInteger(value))) return { t: "n", v: value, z: excelNumberFormat(cell.format) };
  }
  // Explicit string cells never acquire a formula field. Numeric strings from
  // COUNT_BIG keep their precision instead of going through Number().
  return { t: "s", v: String(cell.raw) };
}

interface ExcelStyle { color?: string; bold?: boolean }
function patchWorkbookFeatures(buffer: Uint8Array, names: string[], rowLevels: Map<number, number[]>, headerCounts: Map<number, number>, cellStyles: Map<number, Map<string, ExcelStyle>>): Uint8Array {
  const files = unzipSync(buffer);
  let stylesXml = strFromU8(files["xl/styles.xml"]);
  const fonts: string[] = (/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(stylesXml)?.[1] ?? "").match(/<font\b[^>]*>[\s\S]*?<\/font>/g) ?? [];
  const xfs: string[] = (/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? "").match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  const styleIds = new Map<string, number>();
  const styleId = (base: number, style: ExcelStyle) => {
    const key = JSON.stringify([base, style.bold, style.color]);
    const saved = styleIds.get(key); if (saved !== undefined) return saved;
    let font = fonts[0] || '<font><sz val="11"/><name val="Calibri"/></font>';
    if (style.bold && !/<b\b/.test(font)) font = font.replace("</font>", "<b/></font>");
    if (style.color) {
      const color = `<color rgb="FF${style.color.slice(1).toUpperCase()}"/>`;
      font = /<color\b[^>]*\/>/.test(font) ? font.replace(/<color\b[^>]*\/>/, color) : font.replace("</font>", `${color}</font>`);
    }
    const fontId = fonts.push(font) - 1;
    const original = xfs[base] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const next = original.replace(/\sfontId="\d+"/, ` fontId="${fontId}"`).replace(/\sapplyFont="[^"]*"/, "").replace("<xf ", '<xf applyFont="1" ');
    const id = xfs.push(next) - 1;
    styleIds.set(key, id); return id;
  };
  names.forEach((_name, index) => {
    const key = `xl/worksheets/sheet${index + 1}.xml`;
    let xml = strFromU8(files[key]);
    const freeze = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
    if (/<sheetView\b[^>]*\/>/.test(xml)) xml = xml.replace(/<sheetView\b([^>]*?)\/>/, `<sheetView$1>${freeze}</sheetView>`);
    else if (/<sheetView\b/.test(xml)) xml = xml.replace(/(<sheetView\b[^>]*>)/, `$1${freeze}`);
    else xml = xml.replace(/(<worksheet\b[^>]*>)/, `$1<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews>`);
    const levels = rowLevels.get(index) ?? [];
    xml = xml.replace(/<row\b([^>]*\br="(\d+)"[^>]*)>/g, (all, attributes: string, row: string) => {
      const level = levels[Number(row) - 1];
      if (!level) return all;
      return `<row${attributes.replace(/\soutlineLevel="\d+"/g, "")} outlineLevel="${Math.min(7, level)}">`;
    });
    const headers = headerCounts.get(index) ?? 0;
    if (headers > 0 && !xml.includes("<autoFilter")) xml = xml.replace("</sheetData>", `</sheetData><autoFilter ref="A1:${XLSX.utils.encode_col(headers - 1)}1"/>`);
    const styles = cellStyles.get(index);
    if (styles?.size) xml = xml.replace(/<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>/g, (all, attributes: string, address: string) => {
      const style = styles.get(address); if (!style) return all;
      const base = Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? 0);
      return `<c${attributes.replace(/\ss="\d+"/g, "")} s="${styleId(base, style)}">`;
    });
    files[key] = strToU8(xml);
  });
  stylesXml = stylesXml.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/, `<fonts count="${fonts.length}">${fonts.join("")}</fonts>`)
    .replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/, `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>`);
  files["xl/styles.xml"] = strToU8(stylesXml);
  // Repeat the first row when Excel prints the workbook. Existing exports have
  // no defined names, so only our trusted sheet names enter the XML.
  const workbookKey = "xl/workbook.xml";
  let workbook = strFromU8(files[workbookKey]);
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const namesXml = names.map((name, index) => `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">'${escape(name.replace(/'/g, "''"))}'!$1:$1</definedName>`).join("");
  workbook = workbook.includes("<definedNames>") ? workbook.replace("</definedNames>", `${namesXml}</definedNames>`) : workbook.replace("</workbook>", `<definedNames>${namesXml}</definedNames></workbook>`);
  files[workbookKey] = strToU8(workbook);
  return zipSync(files, { level: 6 });
}

function rowCells(table: ReportTabularData, row: ReportTabularRow): ReportCell[] {
  if (row.rowKind !== "groupHeader") return row.cells;
  return table.columns.map((column, index) => ({ ...column, raw: index ? null : row.label ?? "", text: index ? "" : row.label ?? "", bold: true }));
}

/** One worksheet per tabular item; identical detail/subtotal rows to the preview. */
export function generateReportXlsx(definition: ReportDefinition, data: ReportExecutionData, model?: SemanticModel, reportName?: string): Uint8Array {
  const tables = reportTabularRows(definition, capReportData(definition, data), model);
  const workbook = XLSX.utils.book_new();
  const used = new Set<string>();
  const rowLevels = new Map<number, number[]>(), headerCounts = new Map<number, number>();
  const cellStyles = new Map<number, Map<string, ExcelStyle>>();
  tables.forEach((table, index) => {
    const name = reportSheetName(table.title || `Table ${index + 1}`, used);
    const detail = table.rows;
    const sheet = XLSX.utils.aoa_to_sheet([table.columns.map((column) => column.text)]);
    const styled = new Map<string, ExcelStyle>();
    table.columns.forEach((_column, columnIndex) => styled.set(XLSX.utils.encode_cell({ r: 0, c: columnIndex }), { bold: true }));
    detail.forEach((row, rowIndex) => rowCells(table, row).forEach((cell, columnIndex) => {
      const address = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      sheet[address] = excelCell(cell);
      if (cell.bold || cell.color) styled.set(address, { bold: cell.bold, color: cell.color });
    }));
    cellStyles.set(index, styled);
    sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: detail.length, c: Math.max(0, table.columns.length - 1) } });
    sheet["!cols"] = table.columns.map((column) => ({ wch: Math.min(70, Math.max(8, column.width / 6)) }));
    sheet["!rows"] = [{ hpt: 22 }, ...detail.map((row) => ({ hpt: 18, level: row.rowKind === "detail" ? Math.min(7, (row.level ?? 0) + 1) : Math.max(0, row.level ?? 0) }))];
    sheet["!outline"] = { above: false, left: false };
    rowLevels.set(index, [0, ...detail.map((row) => row.rowKind === "detail" ? Math.min(7, (row.level ?? 0) + 1) : Math.max(0, row.level ?? 0))]);
    headerCounts.set(index, table.columns.length);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  if (!workbook.SheetNames.length) {
    const name = reportSheetName(reportName || definition.header.title || "Report", used);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[name], ["This report has no tabular data."]]), name);
  }
  workbook.Props = { Title: reportName || definition.header.title || "DataForge report", Author: "DataForge", CreatedDate: new Date(data.runAt) };
  return patchWorkbookFeatures(new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx", cellStyles: true, compression: true })), workbook.SheetNames, rowLevels, headerCounts, cellStyles);
}

/** CSV is a flat, formula-safe table union. Values stay raw, with no display rounding. */
export function generateReportCsv(definition: ReportDefinition, data: ReportExecutionData, model?: SemanticModel, reportName?: string): Uint8Array {
  const tables = reportTabularRows(definition, capReportData(definition, data), model);
  const tableHeaders = tables.map((table) => {
    const used = new Set<string>();
    return table.columns.map((column) => {
      const base = column.text || "Column";
      let header = base, ordinal = 1;
      while (used.has(header)) header = `${base} (${++ordinal})`;
      used.add(header); return header;
    });
  });
  const headers = [...new Set(tableHeaders.flat())];
  const multiple = tables.length > 1;
  const lines = [[...(multiple ? ["Report table"] : []), ...headers].map(csvCell).join(",")];
  for (const [index, table] of tables.entries()) {
    const positions = headers.map((header) => tableHeaders[index].indexOf(header));
    for (const row of table.rows) {
      // CSV is flat detail data; server-generated summary rows are deliberately
      // retained and explicitly labeled in the table's first cell by the engine.
      const cells = rowCells(table, row);
      const values = positions.map((position) => position < 0 ? null : cells[position]?.raw ?? null);
      lines.push([...(multiple ? [table.title || reportName || "Table"] : []), ...values].map(csvCell).join(","));
    }
  }
  return strToU8(`\uFEFF${lines.join("\r\n")}\r\n`);
}

export async function generateReportExport(format: ReportExportFormat, input: ReportExportInput): Promise<Uint8Array> {
  checkExportAbort(input.signal);
  if (format === "pdf") return generateReportPdf(input.definition, input.data, input.model, input.name, input.signal);
  const output = format === "xlsx" ? generateReportXlsx(input.definition, input.data, input.model, input.name) : generateReportCsv(input.definition, input.data, input.model, input.name);
  checkExportAbort(input.signal);
  return output;
}
