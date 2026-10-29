import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFRawStream } from "pdf-lib";
import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { parse } from "csv-parse/sync";
import { createEmptyReport, reportDefinitionSchema, type ReportDefinition } from "@/lib/reports/schema";
import { generateReportCsv, generateReportExport, generateReportPdf, generateReportXlsx, reportSheetName } from "@/lib/reports/export";
import { paginateReport, type ReportExecutionData } from "@/lib/reports/pagination";
import type { QueryResult } from "@/lib/semantic/query/types";

const category = { table: "product", column: "category" };
afterEach(() => vi.restoreAllMocks());
function definition(): ReportDefinition {
  const report = createEmptyReport("Sales report");
  return reportDefinitionSchema.parse({ ...report.definition,
    header: { ...report.definition.header, subtitle: "Quarterly results", text: "Internal use" }, footer: { text: "DataForge · Financial summary", showPageNumbers: true },
    parameters: [{ id: "category", name: "Category", type: "single", attribute: category, allowAll: true }],
    items: [{ id: "sales", type: "table", title: "Sales / Category", data: { kind: "fields", rows: [category], values: ["sales", "margin"], filters: [], sort: [] }, columns: [
      { id: "category", label: "Category", width: 210, binding: { kind: "attribute", attribute: category }, align: "left", format: "auto" },
      { id: "sales", label: "Sales", width: 140, binding: { kind: "measure", measure: "sales" }, align: "right", format: "currency" },
      { id: "margin", label: "Margin", width: 100, binding: { kind: "measure", measure: "margin" }, align: "right", format: "percent" },
    ], groups: [], subtotals: false, grandTotal: true, keepTogether: true, conditionalFormats: [{ measure: "sales", op: "gt", value: 100, color: "#008800", bold: true }] }],
  });
}
const result = (rows: QueryResult["rows"]): QueryResult => ({ columns: [
  { key: "a0", name: "Category", type: "string", role: "attribute" }, { key: "m0", name: "sales", type: "number", role: "measure" }, { key: "m1", name: "margin", type: "number", role: "measure" },
], rows, rowCount: rows.length, truncated: false, elapsedMs: 1, fromCache: false, sql: "SELECT generated_only" });
function data(count = 3): ReportExecutionData {
  const rows = Array.from({ length: count }, (_, index) => ({ a0: index === 0 ? 'Office, "Supplies"' : index === 1 ? "Café – Europe" : `Category ${index}`, m0: 1250.25 + index, m1: 0.1253 }));
  return { runAt: "2026-10-29T12:00:00.000Z", parameters: { category: "Furniture" }, items: { sales: { result: result(rows), rows: [category], measures: ["sales", "margin"], totals: [{ key: "grand", groupBy: [], result: { ...result([{ m0: 6000.5, m1: 0.177 }]), columns: result([]).columns.slice(1) } }] } } };
}

function pdfStreams(pdf: PDFDocument): string[] {
  return pdf.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream)) return [];
    try { return [Buffer.from(decodePDFRawStream(object).decode()).toString("latin1")]; } catch { return []; }
  });
}
function cmapFor(stream: string): Map<string, string> {
  const cmap = new Map<string, string>();
  if (/beginbfchar|beginbfrange/.test(stream)) {
    for (const match of stream.matchAll(/<([0-9a-f]{4})>\s*<([0-9a-f]{4,})>/gi)) {
      const units = match[2].match(/.{4}/g) ?? [];
      cmap.set(match[1].toUpperCase(), String.fromCharCode(...units.map((unit) => parseInt(unit, 16))));
    }
  }
  return cmap;
}
function embeddedPdfText(pdf: PDFDocument): string {
  return pdf.getPages().map((page) => {
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    const maps = new Map<string, Map<string, string>>();
    for (const [name, ref] of fonts?.entries() ?? []) {
      const font = pdf.context.lookup(ref, PDFDict);
      const stream = font.lookup(PDFName.of("ToUnicode"));
      if (!(stream instanceof PDFRawStream)) throw new Error("Expected an embedded font character map.");
      maps.set(name.asString().slice(1), cmapFor(Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1")));
    }
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
    let current = "";
    const text: string[] = [];
    for (const ref of refs) {
      const stream = pdf.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) throw new Error("Expected a page content stream.");
      const body = Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
      for (const match of body.matchAll(/\/([^\s]+)\s+[\d.]+\s+Tf|<([0-9a-f]+)>\s*Tj/gi)) {
        if (match[1]) current = match[1];
        else text.push((match[2].match(/.{4}/g) ?? []).map((glyph) => maps.get(current)?.get(glyph.toUpperCase()) ?? "").join(""));
      }
    }
    return text.join("\n");
  }).join("\n");
}

describe("server report PDF export", () => {
  it("rejects a pre-cancelled PDF before creating a document", async () => {
    const controller = new AbortController(); controller.abort();
    const create = vi.spyOn(PDFDocument, "create");
    await expect(generateReportPdf(definition(), data(), undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });

  it("yields to a pending cancellation during a multi-page render and stops drawing further pages", async () => {
    const source = definition(), rows = data(400);
    const expected = paginateReport(source, rows);
    expect(expected.pages.length).toBeGreaterThan(8);
    const controller = new AbortController();
    const addPage = vi.spyOn(PDFDocument.prototype, "addPage");
    const original = PDFPage.prototype.drawText;
    let scheduled = false;
    vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, ...args: Parameters<typeof original>) {
      if (!scheduled) { scheduled = true; setImmediate(() => controller.abort()); }
      return original.apply(this, args);
    });
    await expect(generateReportPdf(source, rows, undefined, undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(scheduled).toBe(true);
    expect(addPage.mock.calls.length).toBeGreaterThan(0);
    expect(addPage.mock.calls.length).toBeLessThan(expected.pages.length);
  });

  it("uses preview page sizes/counts, embeds selectable Unicode text, and draws table rows as vector operations", async () => {
    const source = definition(), rows = data(90);
    const expected = paginateReport(source, rows);
    const bytes = await generateReportPdf(source, rows);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(expected.pages.length);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toBe("Sales report");
    expect(pdf.getPages()[0].getSize()).toEqual({ width: expected.width, height: expected.height });
    const streams = pdfStreams(pdf);
    expect(streams.some((text) => /beginbfchar|beginbfrange/.test(text))).toBe(true);
    expect(streams.some((text) => /BT[\s\S]*Tj/.test(text))).toBe(true);
    // Embedded font ToUnicode maps expose accented and typographical glyphs;
    // text is not rasterized into a screenshot or image.
    const unicode = streams.filter((text) => /beginbfchar|beginbfrange/.test(text)).join("\n").toLowerCase();
    expect(unicode).toContain("00e9");
    expect(unicode).toContain("2013");
    const text = embeddedPdfText(pdf);
    expect(text).toContain("Sales report");
    expect(text).toContain("Quarterly results");
    expect(text).toContain("Café – Europe");
    expect(text).toContain("Furniture");
    expect(text).toContain(`Page 1 of ${expected.pages.length}`);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Subtype /Image");
  });

  it.each(["bar", "line", "area", "donut"] as const)("exports %s charts as vector paths without a headless browser", async (viz) => {
    const source = definition();
    source.items.push({ id: "chart", type: "chart", title: "Category sales", data: { kind: "fields", rows: [category], values: ["sales"], filters: [], sort: [] }, viz, height: 220 });
    const rows = data(); rows.items.chart = rows.items.sales;
    const bytes = await generateReportPdf(source, rows);
    const pdf = await PDFDocument.load(bytes);
    const streams = pdfStreams(pdf).join("\n");
    expect(streams).toMatch(/\bre\b|\bm\b/);
    expect(embeddedPdfText(pdf)).toContain("Category sales");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Subtype /Image");
    expect(pdf.getPageCount()).toBe(paginateReport(source, rows).pages.length);
  });

  it("keeps unsupported glyphs and extreme numeric chart data from failing the whole export", async () => {
    const source = definition();
    source.items.push({ id: "chart", type: "chart", title: "Extreme", data: { kind: "fields", rows: [category], values: ["sales"], filters: [], sort: [] }, viz: "donut", height: 220 });
    const rows = data(); rows.items.chart = { ...rows.items.sales, result: result([{ a0: "🚀 東京", m0: Number.MAX_VALUE }, { a0: "Other", m0: Number.MAX_VALUE }]) };
    expect((await PDFDocument.load(await generateReportPdf(source, rows))).getPageCount()).toBeGreaterThan(0);
  });
});

describe("report Excel export", () => {
  it("retains numeric values, number formats, raw server totals and frozen/repeated headers", () => {
    const bytes = generateReportXlsx(definition(), data());
    const workbook = XLSX.read(bytes, { type: "array", cellNF: true });
    expect(workbook.SheetNames).toEqual(["Sales   Category"]);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    expect(sheet.A2.v).toBe('Office, "Supplies"');
    expect(sheet.B2).toMatchObject({ t: "n", v: 1250.25, z: '"$"#,##0.00;[Red]-"$"#,##0.00' });
    expect(sheet.C2).toMatchObject({ t: "n", v: 0.1253, z: "0.00%" });
    expect(sheet.A5.v).toBe("Grand total");
    expect(sheet.B5.v).toBe(6000.5);
    expect(sheet.C5.v).toBe(0.177); // not a sum/average of displayed ratio rows.
    const files = unzipSync(bytes), xml = strFromU8(files["xl/worksheets/sheet1.xml"]);
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('topLeftCell="A2"');
    expect(xml).toContain('outlineLevel="1"');
    expect(strFromU8(files["xl/workbook.xml"])).toContain('_xlnm.Print_Titles');
    const styles = strFromU8(files["xl/styles.xml"]);
    expect(styles).toContain('<color rgb="FF008800"/>');
    expect(styles).toContain("<b/>");
  });

  it("sanitizes sheet names, removes forbidden names, and handles case-insensitive duplicates", () => {
    const used = new Set<string>();
    expect(reportSheetName("[]:*?/\\", used)).toBe("Table");
    expect(reportSheetName("table", used)).toBe("table (2)");
    expect(reportSheetName("'Sales'", used)).toBe("Sales");
    expect(reportSheetName("x".repeat(100), used)).toHaveLength(31);
    expect(reportSheetName("x".repeat(100), used)).toHaveLength(31);
    expect(used.size).toBe(5);
  });

  it("uses explicit text cells for formula-like strings and preserves BIGINT strings", () => {
    const rows = data(1); rows.items.sales.result.rows = [{ a0: '=HYPERLINK("https://example.invalid")', m0: "9007199254740993", m1: -0.01 }];
    const workbook = XLSX.read(generateReportXlsx(definition(), rows), { type: "array" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    expect(sheet.A2).toMatchObject({ t: "s", v: '=HYPERLINK("https://example.invalid")' });
    expect(sheet.A2.f).toBeUndefined();
    expect(sheet.B2).toMatchObject({ t: "s", v: "9007199254740993" });
  });

  it("converts exact, safe numeric measure strings to formatted Excel numbers", () => {
    const rows = data(1); rows.items.sales.result.rows = [{ a0: "Furniture", m0: "2000", m1: "0.1253" }];
    const workbook = XLSX.read(generateReportXlsx(definition(), rows), { type: "array", cellNF: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    expect(sheet.B2).toMatchObject({ t: "n", v: 2000, z: '"$"#,##0.00;[Red]-"$"#,##0.00' });
    expect(sheet.C2).toMatchObject({ t: "n", v: 0.1253, z: "0.00%" });
  });

  it("formats COUNT_BIG strings numerically while preserving Year and zero-padded identifier attributes", () => {
    const source = definition();
    const table = source.items[0];
    if (table.type !== "table") throw new Error("Expected a table.");
    table.columns[0].label = "Year / Identifier";
    table.columns[1].label = "Row Count";
    table.columns[1].format = "number";
    const rows = data(2);
    rows.items.sales.result.rows = [
      { a0: "2024", m0: "2000", m1: "0.1253" },
      { a0: "00002000", m0: "9007199254740993", m1: "0.1253" },
    ];
    const workbook = XLSX.read(generateReportXlsx(source, rows), { type: "array", cellNF: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    expect(sheet.A2).toMatchObject({ t: "s", v: "2024" });
    expect(sheet.A3).toMatchObject({ t: "s", v: "00002000" });
    expect(sheet.B2).toMatchObject({ t: "n", v: 2000, z: "#,##0.##" });
    expect(sheet.B3).toMatchObject({ t: "s", v: "9007199254740993" });
  });
});

describe("report flat CSV export", () => {
  it("preserves unrounded values, quotes RFC4180 cells and prefixes formula-like strings", () => {
    const rows = data(); rows.items.sales.result.rows.push({ a0: "=1+1", m0: -25, m1: null });
    const bytes = generateReportCsv(definition(), rows);
    const csv = new TextDecoder().decode(bytes);
    const parsed = parse(csv, { bom: true });
    expect(parsed[0]).toEqual(["Category", "Sales", "Margin"]);
    expect(parsed[1]).toEqual(['Office, "Supplies"', "1250.25", "0.1253"]);
    expect(parsed[4]).toEqual(["'=1+1", "-25", ""]);
    expect(csv).toContain('"Office, ""Supplies"""');
    expect(csv).toContain("\r\n");
  });

  it("caps large flat exports to 100,000 data rows", () => {
    const source = definition(); source.items[0] = { ...source.items[0], grandTotal: false } as typeof source.items[0];
    const csv = new TextDecoder().decode(generateReportCsv(source, data(100_002)));
    expect(csv.split("\r\n")).toHaveLength(100_002); // one header, 100k rows, trailing newline.
  });

  it("retains duplicate header columns rather than losing one while flattening", () => {
    const source = definition();
    const table = source.items[0];
    if (table.type !== "table") throw new Error("Expected a table.");
    table.columns[2].label = "Sales";
    const parsed = parse(new TextDecoder().decode(generateReportCsv(source, data())), { bom: true });
    expect(parsed[0]).toEqual(["Category", "Sales", "Sales (2)"]);
    expect(parsed[1]).toEqual(['Office, "Supplies"', "1250.25", "0.1253"]);
  });

  it("preserves group labels and server subtotals in the same tabular sequence as preview", () => {
    const source = definition();
    const table = source.items[0];
    if (table.type !== "table") throw new Error("Expected a table.");
    table.groups = [category]; table.subtotals = true;
    const rows = data(1);
    rows.items.sales.totals?.push({ key: "category", groupBy: [category], result: result([{ a0: 'Office, "Supplies"', m0: 1250.25, m1: 0.1253 }]) });
    const csv = parse(new TextDecoder().decode(generateReportCsv(source, rows)), { bom: true });
    expect(csv[1][0]).toBe('Category: Office, "Supplies"');
    expect(csv[2]).toEqual(['Office, "Supplies"', "1250.25", "0.1253"]);
    expect(csv[3]).toEqual(['Category: Office, "Supplies" subtotal', "1250.25", "0.1253"]);
    const book = XLSX.read(generateReportXlsx(source, rows), { type: "array" });
    const sheet = book.Sheets[book.SheetNames[0]];
    expect(sheet.A2.v).toBe('Category: Office, "Supplies"');
    expect(sheet.B4.v).toBe(1250.25);
  });

  it("dispatches all three public export formats", async () => {
    for (const format of ["pdf", "xlsx", "csv"] as const) {
      const bytes = await generateReportExport(format, { definition: definition(), data: data(), name: "Sales report" });
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(100);
    }
  });

  it.each(["pdf", "xlsx", "csv"] as const)("rejects a cancelled %s request before generation", async (format) => {
    const controller = new AbortController(); controller.abort();
    await expect(generateReportExport(format, { definition: definition(), data: data(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
