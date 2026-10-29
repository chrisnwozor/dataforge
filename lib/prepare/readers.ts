import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import { z } from "zod";
import { checkWorkbookArchive, detectDelimiter, inferType } from "@/lib/profiler";
import type { Cell, PrepareRow, PrepareType } from "./schema";
import { readJsonRows } from "./json-reader";

export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_ROWS = 5_000_000;
export const MAX_SOURCE_COLUMNS = 10_000;
export const sourceKindSchema = z.enum(["csv", "xlsx", "json"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const sourceOptionsSchema = z.object({
  version: z.literal(1).default(1),
  delimiter: z.enum([",", ";", "\t", "|"]).optional(),
  sheetName: z.string().min(1).max(100).optional(),
  headerRow: z.number().int().min(1).max(10_000).default(1),
  jsonArrayPath: z.string().max(1_000).default(""),
  arraySeparator: z.string().max(100).default(" | "),
}).strict();
export type SourceOptions = z.infer<typeof sourceOptionsSchema>;
export interface SourceColumn { name: string; type: PrepareType }
export interface SourceReadRequest { limit?: number; signal?: AbortSignal; onWarning?: (message: string) => void; expectedColumns?: readonly string[] }
export interface SourceFile { filePath: string; kind: SourceKind; options: SourceOptions }
export interface SourceAnalysis { columns: SourceColumn[]; rowCount: number; preview: PrepareRow[]; warnings: string[] }
function verifyColumns(columns: readonly string[], expected?: readonly string[]): void {
  if (expected && (columns.length !== expected.length || columns.some((column, index) => column !== expected[index]))) throw new Error("The source file headers changed outside DataForge. Replace the file through Sources so the pipeline and profile can be updated safely.");
}

export function uniqueSourceHeaders(values: readonly unknown[]): string[] {
  if (!values.length || values.every((value) => String(value ?? "").trim() === "")) throw new Error("The source needs a non-empty header row.");
  if (values.length > MAX_SOURCE_COLUMNS) throw new Error("Sources may contain at most 10,000 columns.");
  const used = new Set<string>();
  return values.map((value, index) => {
    const name = String(value ?? "").trim() || `Column ${index + 1}`;
    if (name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Source column names must be at most 256 characters and cannot contain control characters.");
    let candidate = name, suffix = 2;
    while (used.has(candidate)) candidate = `${name.slice(0, 246)} (${suffix++})`;
    used.add(candidate); return candidate;
  });
}

async function validateSourceSize(path: string): Promise<void> {
  const info = await stat(/* turbopackIgnore: true */ path);
  if (!info.isFile() || !info.size || info.size > MAX_SOURCE_BYTES) throw new Error("Choose a non-empty source file no larger than 50 MB.");
}
async function initialBytes(path: string): Promise<Buffer> {
  const handle = await open(/* turbopackIgnore: true */ path, "r");
  try { const buffer = Buffer.alloc(16 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead); }
  finally { await handle.close(); }
}
function textEncoding(bytes: Buffer): void {
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff || bytes.includes(0)) throw new Error("CSV and JSON sources must use UTF-8 text encoding.");
}

async function* csvRows(source: SourceFile, request: SourceReadRequest): AsyncGenerator<PrepareRow> {
  const bytes = await initialBytes(source.filePath); textEncoding(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const input = createReadStream(/* turbopackIgnore: true */ source.filePath, { highWaterMark: 16 * 1024, signal: request.signal });
  const parser = parse({ bom: true, delimiter: source.options.delimiter ?? detectDelimiter(bytes.toString("utf8")), columns: false, trim: true, skip_empty_lines: true, relax_column_count: true, max_record_size: 2 * 1024 * 1024, ...(request.limit ? { to: source.options.headerRow + request.limit } : {}) });
  async function* checkedBytes() {
    for await (const bytes of input) { request.signal?.throwIfAborted(); decoder.decode(bytes as Buffer, { stream: true }); yield bytes; }
    decoder.decode();
  }
  const pumping = pipeline(checkedBytes(), parser).catch((error: unknown) => { if (!input.destroyed) input.destroy(); if (!parser.destroyed) parser.destroy(error instanceof Error ? error : new Error(String(error))); });
  let index = 0, headers: string[] = [];
  try {
    for await (const raw of parser) {
      request.signal?.throwIfAborted(); index++;
      if (index < source.options.headerRow) continue;
      if (index === source.options.headerRow) { headers = uniqueSourceHeaders(raw as unknown[]); verifyColumns(headers, request.expectedColumns); continue; }
      if (index - source.options.headerRow > MAX_SOURCE_ROWS) throw new Error("Sources are limited to 5,000,000 rows. Split this file into smaller sources.");
      const values = raw as unknown[];
      if (values.length !== headers.length) request.onWarning?.(`Row ${index} has ${values.length} fields; expected ${headers.length}. Missing fields become NULL and extra fields are ignored.`);
      const row: PrepareRow = Object.create(null);
      headers.forEach((name, ordinal) => { row[name] = values[ordinal] === undefined || values[ordinal] === "" ? null : String(values[ordinal]); });
      yield row;
      if (request.limit && index - source.options.headerRow >= request.limit) break;
    }
    if (!headers.length) throw new Error("The selected CSV header row does not exist.");
  } finally { input.destroy(); parser.destroy(); await pumping; }
}

export async function workbookSheetNames(path: string): Promise<string[]> {
  await validateSourceSize(path);
  const archive = await checkWorkbookArchive(path);
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(archive, { type: "buffer", bookSheets: true, bookProps: true, cellFormula: false, cellHTML: false });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 200) throw new Error("Workbooks must contain between one and 200 sheets.");
  return workbook.SheetNames;
}

async function* xlsxRows(source: SourceFile, request: SourceReadRequest): AsyncGenerator<PrepareRow> {
  request.signal?.throwIfAborted();
  const archive = await checkWorkbookArchive(source.filePath);
  const XLSX = await import("xlsx");
  const sheets = XLSX.read(archive, { type: "buffer", bookSheets: true, cellFormula: false, cellHTML: false }).SheetNames;
  const sheetName = source.options.sheetName ?? sheets[0];
  if (!sheets.includes(sheetName)) throw new Error("The selected workbook sheet no longer exists.");
  const workbook = XLSX.read(archive, { type: "buffer", sheets: sheetName, sheetRows: request.limit ? source.options.headerRow + request.limit : 0, cellDates: true, cellFormula: false, cellHTML: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet?.["!ref"]) throw new Error("The selected worksheet is empty.");
  const fullRange = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"]);
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const width = fullRange.e.c - fullRange.s.c + 1;
  if (width > MAX_SOURCE_COLUMNS || fullRange.e.r >= 1_000_000 || !Number.isSafeInteger(width * (fullRange.e.r + 1)) || width * (fullRange.e.r + 1) > 2_000_000) throw new Error("The worksheet exceeds the 10,000-column, 1,000,000-row, or 2,000,000-cell budget. Export a smaller range as CSV.");
  const header = source.options.headerRow - 1;
  if (header > range.e.r) throw new Error("The selected worksheet header row does not exist.");
  const valuesAt = (row: number) => Array.from({ length: width }, (_, offset) => {
    const cell = sheet[XLSX.utils.encode_cell({ r: row, c: fullRange.s.c + offset })];
    const value = cell?.t === "e" ? cell.w ?? String(cell.v) : cell?.v ?? null;
    return value instanceof Date ? Number.isFinite(value.getTime()) ? value.toISOString() : null : typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const headers = uniqueSourceHeaders(valuesAt(header)); verifyColumns(headers, request.expectedColumns); let count = 0;
  for (let index = header + 1; index <= range.e.r; index++) {
    request.signal?.throwIfAborted(); const values = valuesAt(index);
    if (values.every((value) => value === null || value === "")) continue;
    yield Object.fromEntries(headers.map((name, offset) => [name, values[offset] ?? null]));
    if (++count >= (request.limit ?? MAX_SOURCE_ROWS)) return;
  }
}

export async function* readSourceRows(source: SourceFile, request: SourceReadRequest = {}): AsyncGenerator<PrepareRow> {
  const options = sourceOptionsSchema.parse(source.options);
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_SOURCE_ROWS)) throw new Error("Choose a positive source row limit up to 5,000,000.");
  request.signal?.throwIfAborted(); await validateSourceSize(source.filePath);
  if (source.kind === "csv") yield* csvRows({ ...source, options }, request);
  else if (source.kind === "xlsx") yield* xlsxRows({ ...source, options }, request);
  else for await (const row of readJsonRows(source.filePath, { arrayPath: options.jsonArrayPath, arraySeparator: options.arraySeparator, ...request })) {
    if (request.expectedColumns && Object.keys(row).some((column) => !request.expectedColumns!.includes(column))) throw new Error("The JSON source has new columns outside its saved schema. Replace the file through Sources to update the pipeline safely.");
    yield row;
  }
}

export async function analyzeSource(source: SourceFile, request: Omit<SourceReadRequest, "limit"> = {}): Promise<SourceAnalysis> {
  const samples = new Map<string, string[]>(), preview: PrepareRow[] = [], warnings = new Set<string>(); let rowCount = 0;
  const warn = (message: string) => { if (warnings.size < 20) warnings.add(message); request.onWarning?.(message); };
  for await (const row of readSourceRows(source, { ...request, onWarning: warn })) {
    rowCount++;
    for (const [name, value] of Object.entries(row)) {
      let values = samples.get(name);
      if (!values) { if (samples.size >= MAX_SOURCE_COLUMNS) throw new Error("Sources may contain at most 10,000 columns."); values = []; samples.set(name, values); }
      if (value !== null && value !== "" && values.length < 1_000) values.push(String(value));
    }
    if (preview.length < 20) preview.push(row);
  }
  if (!samples.size) {
    // CSV/XLSX headers remain useful even when a valid source has no data rows.
    if (source.kind === "csv") {
      const bytes = await initialBytes(source.filePath); const parser = parse({ bom: true, delimiter: source.options.delimiter ?? detectDelimiter(bytes.toString("utf8")), to: source.options.headerRow, relax_column_count: true, skip_empty_lines: true });
      parser.write(bytes); parser.end(); let raw: unknown[] | undefined; for await (const row of parser) raw = row;
      if (raw) uniqueSourceHeaders(raw).forEach((name) => samples.set(name, []));
    }
    if (!samples.size) throw new Error("The source has no columns. Choose a sheet or JSON array containing objects with fields.");
  }
  return { columns: [...samples].map(([name, values]) => ({ name, type: inferType(values) })), rowCount, preview, warnings: [...warnings] };
}

export function normalizeSourceRow(row: PrepareRow, columns: readonly SourceColumn[]): PrepareRow {
  return Object.fromEntries(columns.map(({ name }) => [name, (Object.hasOwn(row, name) ? row[name] : null) as Cell]));
}
