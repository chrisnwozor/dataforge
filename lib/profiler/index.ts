import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import {
  booleanValue,
  dateValue,
  decimalValue,
  inferType,
  integerValue,
  TYPE_SAMPLE_LIMIT,
} from "./inference";
import type { InferredType, ProfileColumn, ProfileResult } from "./types";

export { inferType } from "./inference";
export type { InferredType, ProfileColumn, ProfileResult } from "./types";

const MAX_COLUMNS = 10_000;
const MAX_XLSX_ROWS = 1_000_000;
const MAX_XLSX_CELL_VISITS = 2_000_000;
const MAX_XLSX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_RAGGED_EXAMPLES = 5;
type Comparable = string | number | bigint;
interface Bounds {
  min: Comparable;
  max: Comparable;
  minRaw: string;
  maxRaw: string;
}
interface ColumnState {
  name: string;
  nulls: number;
  nonNulls: number;
  distinct: Set<string>;
  samples: string[];
  inference: string[];
  bounds: Partial<Record<InferredType, Bounds>>;
}

function updateBounds(
  column: ColumnState,
  type: InferredType,
  value: Comparable | null,
  raw: string,
) {
  if (value === null) return;
  const bounds = column.bounds[type];
  if (!bounds) {
    column.bounds[type] = { min: value, max: value, minRaw: raw, maxRaw: raw };
    return;
  }
  const lower =
    type === "decimal"
      ? compareExactDecimals(raw, bounds.minRaw) < 0
      : value < bounds.min;
  const higher =
    type === "decimal"
      ? compareExactDecimals(raw, bounds.maxRaw) > 0
      : value > bounds.max;
  if (lower) {
    bounds.min = value;
    bounds.minRaw = raw;
  }
  if (higher) {
    bounds.max = value;
    bounds.maxRaw = raw;
  }
}

interface SignedIntegerKey {
  sign: -1 | 0 | 1;
  digits: string;
}

function integerKey(value: string): SignedIntegerKey {
  const negative = value.startsWith("-");
  const digits = value.replace(/^[+-]/, "").replace(/^0+/, "");
  return { sign: digits ? (negative ? -1 : 1) : 0, digits };
}

/** Add a small digit-position adjustment without constructing 10 ** exponent. */
function shiftedExponent(value: string, offset: number): SignedIntegerKey {
  const key = integerKey(value);
  if (key.digits.length <= 16)
    return integerKey(
      (
        BigInt((key.sign < 0 ? "-" : "") + (key.digits || "0")) + BigInt(offset)
      ).toString(),
    );
  const tailBase = BigInt("10000000000000000");
  const split = key.digits.length - 16;
  let prefix = key.digits.slice(0, split);
  let tail = BigInt(key.digits.slice(split)) + BigInt(key.sign * offset);
  if (tail >= tailBase) {
    tail -= tailBase;
    const nines = /9*$/.exec(prefix)![0].length;
    prefix =
      nines === prefix.length
        ? "1" + "0".repeat(nines)
        : prefix.slice(0, -nines - 1) +
          String(Number(prefix[prefix.length - nines - 1]) + 1) +
          "0".repeat(nines);
  } else if (tail < BigInt(0)) {
    tail += tailBase;
    const zeros = /0*$/.exec(prefix)![0].length;
    prefix =
      prefix.slice(0, -zeros - 1) +
      String(Number(prefix[prefix.length - zeros - 1]) - 1) +
      "9".repeat(zeros);
  }
  return integerKey(
    (key.sign < 0 ? "-" : "") + prefix + tail.toString().padStart(16, "0"),
  );
}

function compareIntegerKeys(
  left: SignedIntegerKey,
  right: SignedIntegerKey,
): number {
  if (left.sign !== right.sign) return left.sign - right.sign;
  if (!left.sign) return 0;
  const absolute =
    left.digits.length !== right.digits.length
      ? left.digits.length - right.digits.length
      : left.digits < right.digits
        ? -1
        : left.digits > right.digits
          ? 1
          : 0;
  return absolute * left.sign;
}

/** Compare decimal strings exactly; memory stays proportional to the input, not its exponent. */
function compareExactDecimals(left: string, right: string): number {
  const key = (value: string) => {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(
      value.replaceAll(",", ""),
    )!;
    const fraction = match[3] ?? "";
    const digits = (match[2] + fraction).replace(/^0+/, "");
    return {
      sign: digits ? (match[1] === "-" ? -1 : 1) : 0,
      digits,
      magnitude: shiftedExponent(
        match[4] ?? "0",
        digits.length - fraction.length,
      ),
    };
  };
  const a = key(left),
    b = key(right);
  if (a.sign !== b.sign) return a.sign - b.sign;
  if (!a.sign) return 0;
  const magnitude = compareIntegerKeys(a.magnitude, b.magnitude);
  if (magnitude) return magnitude * a.sign;
  for (
    let index = 0;
    index < Math.max(a.digits.length, b.digits.length);
    index++
  ) {
    const difference =
      (a.digits[index] ?? "0").charCodeAt(0) -
      (b.digits[index] ?? "0").charCodeAt(0);
    if (difference) return difference * a.sign;
  }
  return 0;
}

class ProfileAccumulator {
  private columns: ColumnState[] = [];
  private rowCount = 0;
  private raggedRowCount = 0;
  private raggedRowExamples: ProfileResult["raggedRowExamples"] = [];

  add(record: unknown[]) {
    if (!this.columns.length) {
      if (
        !record.length ||
        record.every((value) => String(value ?? "").trim() === "")
      )
        throw new Error("The file must have a non-empty header row.");
      if (record.length > MAX_COLUMNS)
        throw new Error(
          `Files may contain at most ${MAX_COLUMNS.toLocaleString("en-US")} columns.`,
        );
      this.columns = record.map((value, index) => ({
        name: String(value ?? "").trim() || `Column ${index + 1}`,
        nulls: 0,
        nonNulls: 0,
        distinct: new Set(),
        samples: [],
        inference: [],
        bounds: {},
      }));
      return;
    }
    this.rowCount++;
    if (record.length !== this.columns.length) {
      this.raggedRowCount++;
      if (this.raggedRowExamples.length < MAX_RAGGED_EXAMPLES)
        this.raggedRowExamples.push({
          row: this.rowCount + 1,
          expected: this.columns.length,
          actual: record.length,
        });
    }
    this.columns.forEach((column, ordinal) => {
      const raw = record[ordinal];
      const value =
        raw instanceof Date ? raw.toISOString() : String(raw ?? "").trim();
      if (value === "") {
        column.nulls++;
        return;
      }
      column.nonNulls++;
      if (!column.distinct.has(value)) {
        column.distinct.add(value);
        if (column.samples.length < 5) column.samples.push(value);
      }
      if (column.inference.length < TYPE_SAMPLE_LIMIT)
        column.inference.push(value);
      updateBounds(column, "text", value, value);
      updateBounds(column, "boolean", booleanValue(value), value);
      updateBounds(column, "integer", integerValue(value), value);
      updateBounds(column, "decimal", decimalValue(value), value);
      updateBounds(column, "date", dateValue(value), value);
    });
  }

  finish(delimiter: string): ProfileResult {
    if (!this.columns.length)
      throw new Error(
        "The file is empty. Include a header row and at least one data row.",
      );
    if (!this.rowCount)
      throw new Error("The file contains column headers but no data rows.");
    const columns: ProfileColumn[] = this.columns.map((column, ordinal) => {
      const inferredType = inferType(column.inference);
      const bounds = column.bounds[inferredType];
      return {
        ordinal,
        name: column.name,
        inferredType,
        nullPct: Math.round((column.nulls / this.rowCount) * 10_000) / 100,
        distinctCount: column.distinct.size,
        duplicateCount: column.nonNulls - column.distinct.size,
        minValue: bounds?.minRaw ?? null,
        maxValue: bounds?.maxRaw ?? null,
        isKeyCandidate:
          column.nulls === 0 && column.distinct.size === this.rowCount,
        sampleValues: column.samples,
      };
    });
    return {
      rowCount: this.rowCount,
      columnCount: columns.length,
      columns,
      raggedRowCount: this.raggedRowCount,
      raggedRowExamples: this.raggedRowExamples,
      delimiter,
    };
  }
}

/** Count separators outside quoted fields in the first few complete logical records. */
export function detectDelimiter(sample: string): string {
  const candidates = [",", ";", "\t"];
  const counts: number[][] = [];
  let current = [0, 0, 0];
  let quoted = false;
  let hasContent = false;
  for (let i = 0; i < sample.length && counts.length < 25; i++) {
    const character = sample[i];
    if (character === '"') {
      if (quoted && sample[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (!quoted && (character === "\r" || character === "\n")) {
      if (hasContent) counts.push(current);
      current = [0, 0, 0];
      hasContent = false;
      if (character === "\r" && sample[i + 1] === "\n") i++;
      continue;
    }
    if (!quoted) {
      const separator = candidates.indexOf(character);
      if (separator !== -1) current[separator]++;
    }
    if (character.trim()) hasContent = true;
  }
  if (!quoted && hasContent && counts.length < 25) counts.push(current);
  if (!counts.length) counts.push(current);
  let selected = 0;
  let bestScore = -1;
  candidates.forEach((_, index) => {
    const headerCount = counts[0][index];
    if (!headerCount) return;
    const matches = counts.filter((row) => row[index] === headerCount).length;
    const score =
      (matches / counts.length) * 100 + Math.min(headerCount, 100) / 100;
    if (score > bestScore) {
      bestScore = score;
      selected = index;
    }
  });
  return candidates[selected];
}

async function profileCsv(filePath: string): Promise<ProfileResult> {
  const source = createReadStream(filePath);
  const iterator = source[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done)
      throw new Error(
        "The file is empty. Include a header row and at least one data row.",
      );
    const firstChunk = Buffer.from(first.value as Uint8Array);
    if (
      (firstChunk[0] === 0xff && firstChunk[1] === 0xfe) ||
      (firstChunk[0] === 0xfe && firstChunk[1] === 0xff)
    )
      throw new Error("CSV files must be saved as UTF-8 text, not UTF-16.");
    const delimiter = detectDelimiter(
      firstChunk.toString("utf8").replace(/^\uFEFF/, ""),
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    async function* chunks() {
      let next: IteratorResult<unknown> = { done: false, value: firstChunk };
      while (!next.done) {
        const chunk = Buffer.from(next.value as Uint8Array);
        for (const byte of chunk)
          if (
            (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) ||
            byte === 127
          )
            throw new Error(
              "CSV files must contain text, not binary or unsupported control characters.",
            );
        try {
          decoder.decode(chunk, { stream: true });
        } catch {
          throw new Error("CSV files must use valid UTF-8 text encoding.");
        }
        yield chunk;
        next = await iterator.next();
      }
      try {
        decoder.decode();
      } catch {
        throw new Error("CSV files must use valid UTF-8 text encoding.");
      }
    }
    const parser = parse({
      bom: true,
      delimiter,
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: 50 * 1024 * 1024,
    });
    const accumulator = new ProfileAccumulator();
    const controller = new AbortController();
    const reading = (async () => {
      try {
        for await (const record of parser) accumulator.add(record as string[]);
      } catch (error) {
        controller.abort();
        throw error;
      }
    })();
    await Promise.all([
      pipeline(Readable.from(chunks()), parser, { signal: controller.signal }),
      reading,
    ]);
    return accumulator.finish(delimiter);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      String(error.code).startsWith("CSV_")
    )
      throw new Error(`The CSV could not be read: ${error.message}`);
    throw error;
  } finally {
    source.destroy();
  }
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate the exact ZIP directory and bounded actual output before SheetJS can decompress anything. */
async function checkWorkbookArchive(filePath: string): Promise<Buffer> {
  const archive = await readFile(filePath);
  const invalid = () =>
    new Error(
      "The XLSX workbook archive is invalid or has inconsistent ZIP metadata.",
    );
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  // SheetJS locates the last EOCD signature. Validate that same location, rejecting
  // ambiguous signatures in comments instead of validating a different directory.
  if (
    end < Math.max(0, archive.length - 65_557) ||
    end + 22 > archive.length ||
    end + 22 + archive.readUInt16LE(end + 20) !== archive.length
  )
    throw invalid();
  const entries = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== entries ||
    entries === 0xffff ||
    entries > 10_000 ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directorySize > 8 * 1024 * 1024 ||
    directoryOffset + directorySize !== end
  )
    throw invalid();
  const spans: { start: number; end: number }[] = [];
  const names = new Set<string>();
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let entry = 0; entry < entries; entry++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50)
      throw invalid();
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressed = archive.readUInt32LE(cursor + 20);
    const uncompressed = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      entryEnd > end ||
      archive.readUInt16LE(cursor + 34) !== 0 ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff ||
      flags & ~0x080e ||
      (method !== 0 && method !== 8) ||
      localOffset + 30 > directoryOffset
    )
      throw invalid();
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const nameKey = name.toString("hex");
    if (!nameLength || names.has(nameKey)) throw invalid();
    names.add(nameKey);
    if (
      archive.readUInt32LE(localOffset) !== 0x04034b50 ||
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      archive.readUInt16LE(localOffset + 26) !== nameLength
    )
      throw invalid();
    const localNameEnd = localOffset + 30 + nameLength;
    const dataOffset = localNameEnd + archive.readUInt16LE(localOffset + 28);
    if (
      dataOffset > directoryOffset ||
      !archive.subarray(localOffset + 30, localNameEnd).equals(name) ||
      dataOffset + compressed > directoryOffset
    )
      throw invalid();
    const descriptor = Boolean(flags & 8);
    for (const [position, expected] of [
      [14, checksum],
      [18, compressed],
      [22, uncompressed],
    ]) {
      const actual = archive.readUInt32LE(localOffset + position);
      if (actual !== expected && !(descriptor && actual === 0)) throw invalid();
    }
    let spanEnd = dataOffset + compressed;
    if (descriptor) {
      const signature =
        spanEnd + 4 <= directoryOffset &&
        archive.readUInt32LE(spanEnd) === 0x08074b50;
      const descriptorOffset = spanEnd + (signature ? 4 : 0);
      if (
        descriptorOffset + 12 > directoryOffset ||
        archive.readUInt32LE(descriptorOffset) !== checksum ||
        archive.readUInt32LE(descriptorOffset + 4) !== compressed ||
        archive.readUInt32LE(descriptorOffset + 8) !== uncompressed
      )
        throw invalid();
      spanEnd = descriptorOffset + 12;
    }
    const remaining = MAX_XLSX_EXPANDED_BYTES - expandedBytes;
    if (uncompressed > remaining)
      throw new Error(
        "The expanded workbook must be smaller than 256 MB. Export the first worksheet as CSV for larger files.",
      );
    const compressedBytes = archive.subarray(
      dataOffset,
      dataOffset + compressed,
    );
    let content: Buffer;
    if (method === 0) {
      if (compressed !== uncompressed) throw invalid();
      content = compressedBytes;
    } else {
      try {
        content = inflateRawSync(compressedBytes, {
          maxOutputLength: Math.max(
            1,
            Math.min(uncompressed + 1, remaining + 1),
          ),
        });
      } catch {
        throw new Error(
          "The XLSX archive exceeds its declared or allowed expanded size, or contains invalid compressed data.",
        );
      }
    }
    if (content.length !== uncompressed || crc32(content) !== checksum)
      throw invalid();
    expandedBytes += content.length;
    spans.push({ start: localOffset, end: spanEnd });
    cursor = entryEnd;
  }
  if (cursor !== end) throw invalid();
  spans.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index++)
    if (spans[index].start < spans[index - 1].end) throw invalid();
  return archive;
}

async function profileXlsx(filePath: string): Promise<ProfileResult> {
  const archive = await checkWorkbookArchive(filePath);
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(archive, {
    type: "buffer",
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    sheets: 0,
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.["!ref"])
    throw new Error(
      "The first worksheet is empty. Include a header row and at least one data row.",
    );
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (
    range.e.c - range.s.c + 1 > MAX_COLUMNS ||
    range.e.r - range.s.r > MAX_XLSX_ROWS
  )
    throw new Error(
      "The first worksheet exceeds the limit of 10,000 columns or 1,000,000 data rows. Export a smaller range as CSV.",
    );
  const cellVisits = (range.e.c - range.s.c + 1) * (range.e.r - range.s.r + 1);
  if (!Number.isSafeInteger(cellVisits) || cellVisits > MAX_XLSX_CELL_VISITS)
    throw new Error(
      "The first worksheet exceeds the 2,000,000 cell profiling budget. Remove distant empty cells or export a smaller range as CSV.",
    );
  const accumulator = new ProfileAccumulator();
  // Walk worksheet cells directly rather than creating a second full matrix in memory.
  for (let row = range.s.r; row <= range.e.r; row++) {
    const values: unknown[] = [];
    let hasValue = false;
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
      let value: unknown = cell?.v ?? "";
      if (cell?.t === "e") value = cell.w ?? String(cell.v);
      if (value !== "" && value !== null && value !== undefined)
        hasValue = true;
      values.push(value);
    }
    if (hasValue) accumulator.add(values);
  }
  return accumulator.finish("xlsx");
}

/** Server-only filesystem profiling; CSV records are consumed in a single streamed pass. */
export async function profileFile(
  filePath: string,
  sourceType: "CSV" | "XLSX",
): Promise<ProfileResult> {
  return sourceType === "CSV" ? profileCsv(filePath) : profileXlsx(filePath);
}
