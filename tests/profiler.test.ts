import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { inferType, profileFile, detectDelimiter } from "../lib/profiler";

const temporaryDirectories: string[] = [];
async function csv(contents: string | Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "dataforge-profiler-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "data.csv");
  await writeFile(path, contents);
  return profileFile(path, "CSV");
}
async function workbookFile(contents: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "dataforge-workbook-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "test.xlsx");
  await writeFile(path, contents);
  return path;
}

/** Minimal standards-compliant ZIP fixture builder, with deliberate metadata corruptions for tests. */
function zipFixture(
  content: Buffer,
  options: {
    declaredSize?: number;
    localSize?: number;
    descriptorSize?: number;
    checksum?: number;
  } = {},
) {
  const compressed = deflateRawSync(content);
  const name = Buffer.from("fixture.txt");
  const checksum = options.checksum ?? crc32(content);
  const size = options.declaredSize ?? content.length;
  const descriptor = options.descriptorSize !== undefined;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(descriptor ? 8 : 0, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(descriptor ? 0 : checksum, 14);
  header.writeUInt32LE(descriptor ? 0 : compressed.length, 18);
  header.writeUInt32LE(descriptor ? 0 : (options.localSize ?? size), 22);
  header.writeUInt16LE(name.length, 26);
  const dataDescriptor = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) {
    dataDescriptor.writeUInt32LE(0x08074b50, 0);
    dataDescriptor.writeUInt32LE(checksum, 4);
    dataDescriptor.writeUInt32LE(compressed.length, 8);
    dataDescriptor.writeUInt32LE(options.descriptorSize!, 12);
  }
  const local = Buffer.concat([header, name, compressed, dataDescriptor]);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(descriptor ? 8 : 0, 8);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(checksum, 16);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(size, 24);
  directory.writeUInt16LE(name.length, 28);
  const central = Buffer.concat([directory, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("type inference", () => {
  it("recognizes integer, decimal, explicit boolean, date, and text values", () => {
    expect(inferType(["0", "-12", "+34"])).toBe("integer");
    expect(inferType(["1,234", "2,345"])).toBe("integer");
    expect(inferType(["1.25", "-6.7", "8e2"])).toBe("decimal");
    expect(inferType(["TRUE", "false", "Yes", "no"])).toBe("boolean");
    expect(inferType(["2024-02-29", "2025-01-03"])).toBe("date");
    expect(inferType(["02/29/2024", "12/31/2025"])).toBe("date");
    expect(inferType(["2026-01-01T15:30:00Z", "2026-02-02 16:40:00"])).toBe(
      "date",
    );
    expect(inferType(["CA-2026-10001", "US-2026-10002"])).toBe("text");
  });
  it("rejects invalid calendar dates, timestamps, and numeric lookalikes", () => {
    expect(inferType(["2025-02-29", "2026-02-30"])).toBe("text");
    expect(inferType(["2026-01-01T25:00:00Z"])).toBe("text");
    expect(inferType(["2025-13-01"])).toBe("text");
    expect(inferType(["1e309"])).toBe("text");
    expect(inferType(["1,23"])).toBe("text");
  });
  it("requires a 95% match and ignores null/empty values", () => {
    expect(
      inferType([...Array(95).fill("42"), ...Array(5).fill("unknown")]),
    ).toBe("integer");
    expect(
      inferType([...Array(94).fill("42"), ...Array(6).fill("unknown")]),
    ).toBe("text");
    expect(inferType(["", "  ", "1", "2"])).toBe("integer");
    expect(inferType(["", "  "])).toBe("text");
  });
  it("uses only the first 1,000 non-null values", () => {
    expect(
      inferType([
        ...Array(100).fill(""),
        ...Array(1000).fill("7"),
        ...Array(1000).fill("later text"),
      ]),
    ).toBe("integer");
  });
});

describe("CSV profiling", () => {
  it("calculates nulls, exact distinct/duplicate counts, samples, numeric bounds, and keys", async () => {
    const result = await csv(
      "id,amount,customer,empty\n1,10,Alice,\n2,,Bob,\n3,2,Alice,\n4,   ,Carol,\n",
    );
    expect(result.rowCount).toBe(4);
    expect(result.columnCount).toBe(4);
    expect(result.raggedRowCount).toBe(0);
    expect(result.columns[0]).toMatchObject({
      name: "id",
      inferredType: "integer",
      nullPct: 0,
      distinctCount: 4,
      duplicateCount: 0,
      minValue: "1",
      maxValue: "4",
      isKeyCandidate: true,
      sampleValues: ["1", "2", "3", "4"],
    });
    expect(result.columns[1]).toMatchObject({
      inferredType: "integer",
      nullPct: 50,
      distinctCount: 2,
      duplicateCount: 0,
      minValue: "2",
      maxValue: "10",
      isKeyCandidate: false,
    });
    expect(result.columns[2]).toMatchObject({
      nullPct: 0,
      distinctCount: 3,
      duplicateCount: 1,
      isKeyCandidate: false,
      sampleValues: ["Alice", "Bob", "Carol"],
    });
    expect(result.columns[3]).toMatchObject({
      inferredType: "text",
      nullPct: 100,
      distinctCount: 0,
      duplicateCount: 0,
      minValue: null,
      maxValue: null,
      sampleValues: [],
    });
  });
  it("handles UTF-8 BOM, quoted separators, escaped quotes, CRLF and embedded newlines", async () => {
    const result = await csv(
      '\uFEFFid,name,notes\r\n1,"Doe, Jane","Said ""hello"""\r\n2,"Smith, John","First line\nsecond line"\r\n',
    );
    expect(result.delimiter).toBe(",");
    expect(result.rowCount).toBe(2);
    expect(result.columns[0].name).toBe("id");
    expect(result.columns[1].sampleValues).toEqual([
      "Doe, Jane",
      "Smith, John",
    ]);
    expect(result.columns[2].sampleValues).toEqual([
      'Said "hello"',
      "First line\nsecond line",
    ]);
  });
  it.each([";", "\t"])(
    "detects %j delimiters without splitting commas inside values",
    async (delimiter) => {
      const result = await csv(
        `id${delimiter}customer${delimiter}amount\n1${delimiter}"Smith, Alice"${delimiter}2.5\n2${delimiter}Jones${delimiter}3.1\n`,
      );
      expect(result.delimiter).toBe(delimiter);
      expect(result.columnCount).toBe(3);
      expect(result.rowCount).toBe(2);
      expect(result.columns[1].sampleValues[0]).toBe("Smith, Alice");
    },
  );
  it("counts and reports short/long ragged records without stopping", async () => {
    const result = await csv(
      "id,name,amount\n1,Alice,10\n2,Bob\n3,Carol,30,unexpected\n4,Dan,40\n",
    );
    expect(result.rowCount).toBe(4);
    expect(result.columnCount).toBe(3);
    expect(result.raggedRowCount).toBe(2);
    expect(result.raggedRowExamples).toEqual([
      { row: 3, expected: 3, actual: 2 },
      { row: 4, expected: 3, actual: 4 },
    ]);
    expect(result.columns[2].nullPct).toBe(25);
    expect(result.columns[2].maxValue).toBe("40");
  });
  it("orders dates chronologically and infers booleans with their bounds", async () => {
    const result = await csv(
      "date,active\n12/31/2025,true\n01/01/2024,false\n02/29/2024,TRUE\n",
    );
    expect(result.columns[0]).toMatchObject({
      inferredType: "date",
      minValue: "01/01/2024",
      maxValue: "12/31/2025",
    });
    expect(result.columns[1]).toMatchObject({
      inferredType: "boolean",
      minValue: "false",
      maxValue: "true",
    });
  });
  it("caps samples at five distinct values while keeping full-file metrics", async () => {
    const result = await csv(
      "value\n" +
        Array.from({ length: 1100 }, (_, i) =>
          i < 1000 ? String(i) : "later text",
        ).join("\n"),
    );
    expect(result.rowCount).toBe(1100);
    expect(result.columns[0].inferredType).toBe("integer");
    expect(result.columns[0].distinctCount).toBe(1001);
    expect(result.columns[0].duplicateCount).toBe(99);
    expect(result.columns[0].sampleValues).toEqual(["0", "1", "2", "3", "4"]);
    expect(result.columns[0].maxValue).toBe("999");
  });
  it("keeps exact integer bounds beyond Number.MAX_SAFE_INTEGER", async () => {
    const result = await csv("id\n9007199254740993\n9007199254740992\n");
    expect(result.columns[0]).toMatchObject({
      minValue: "9007199254740992",
      maxValue: "9007199254740993",
    });
  });
  it("keeps decimal bounds exact beyond floating-point precision", async () => {
    const result = await csv(
      "amount,negative\n1000000000000000.01,-1000000000000000.01\n1000000000000000.02,-1000000000000000.02\n",
    );
    expect(result.columns[0]).toMatchObject({
      inferredType: "decimal",
      minValue: "1000000000000000.01",
      maxValue: "1000000000000000.02",
    });
    expect(result.columns[1]).toMatchObject({
      inferredType: "decimal",
      minValue: "-1000000000000000.02",
      maxValue: "-1000000000000000.01",
    });
  });
  it("compares scientific notation exactly without expanding huge powers", async () => {
    const result = await csv(
      "amount\n1e-100000000000000000000\n9e-100000000000000000000\n1e-99999999999999999999\n",
    );
    expect(result.columns[0]).toMatchObject({
      inferredType: "decimal",
      minValue: "1e-100000000000000000000",
      maxValue: "1e-99999999999999999999",
    });
    const regular = await csv(
      "amount\n1.00000000000000001e2\n100.000000000000002\n",
    );
    expect(regular.columns[0]).toMatchObject({
      minValue: "1.00000000000000001e2",
      maxValue: "100.000000000000002",
    });
  });
  it("uses stable names for blank headers and ignores blank physical lines", async () => {
    const result = await csv("id,,name\n\n1,10,Alice\n\n2,20,Bob\n");
    expect(result.rowCount).toBe(2);
    expect(result.columns[1].name).toBe("Column 2");
  });
  it("rejects empty/header-only/binary/invalid-UTF8/malformed CSV files", async () => {
    await expect(csv("")).rejects.toThrow(/empty/i);
    await expect(csv("id,name\n")).rejects.toThrow(/no data rows/i);
    await expect(csv("id,name\n1,hello\u0000\n")).rejects.toThrow(
      /binary|control/i,
    );
    await expect(
      csv(Buffer.from([0x69, 0x64, 0x0a, 0xff, 0x0a])),
    ).rejects.toThrow(/UTF-8/i);
    await expect(csv('id,name\n1,"unfinished\n')).rejects.toThrow(/CSV|quote/i);
  });
  it("sniffs delimiters only outside quoted logical records", () => {
    expect(
      detectDelimiter(
        'id;"Description, with comma";amount\n1;"Multiline\nfield";12\n',
      ),
    ).toBe(";");
  });
  it("profiles the provided 2,000-row, 11-column sample", async () => {
    const samplePath = join(process.cwd(), "samples", "superstore_sales.csv");
    expect((await readFile(samplePath)).length).toBeGreaterThan(100_000);
    const result = await profileFile(samplePath, "CSV");
    expect(result.rowCount).toBe(2000);
    expect(result.columnCount).toBe(11);
    expect(result.raggedRowCount).toBe(0);
    expect(
      result.columns.find((column) => column.name === "Order ID")
        ?.isKeyCandidate,
    ).toBe(true);
    expect(
      result.columns.find((column) => column.name === "Order Date")
        ?.inferredType,
    ).toBe("date");
    expect(
      result.columns.find((column) => column.name === "Sales")?.inferredType,
    ).toBe("decimal");
  });
});

describe("XLSX profiling", () => {
  it("profiles only the first worksheet with numeric, date, and boolean cells", async () => {
    const XLSX = await import("xlsx");
    const directory = await mkdtemp(join(tmpdir(), "dataforge-workbook-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sales.xlsx");
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["id", "amount", "date", "active"],
      [1, 12.5, new Date("2026-01-02T00:00:00Z"), true],
      [2, 4.25, new Date("2026-01-03T00:00:00Z"), false],
    ]);
    XLSX.utils.book_append_sheet(book, sheet, "Sales");
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["ignored"], ["second sheet"]]),
      "Other",
    );
    XLSX.writeFile(book, path, { compression: true });
    const result = await profileFile(path, "XLSX");
    expect(result.rowCount).toBe(2);
    expect(result.columnCount).toBe(4);
    expect(result.columns.map((column) => column.inferredType)).toEqual([
      "integer",
      "decimal",
      "date",
      "boolean",
    ]);
  });
  it("rejects local/central size mismatches before SheetJS sees the archive", async () => {
    const path = await workbookFile(
      zipFixture(Buffer.from("small"), {
        declaredSize: 5,
        localSize: 4 * 1024 * 1024,
      }),
    );
    await expect(profileFile(path, "XLSX")).rejects.toThrow(
      /inconsistent ZIP metadata/i,
    );
  });
  it("bounds actual inflation even when both size declarations are forged", async () => {
    const path = await workbookFile(
      zipFixture(Buffer.alloc(3 * 1024 * 1024, "A"), { declaredSize: 64 }),
    );
    await expect(profileFile(path, "XLSX")).rejects.toThrow(
      /exceeds its declared or allowed expanded size/i,
    );
  });
  it("validates data-descriptor sizes and actual CRCs", async () => {
    const descriptor = await workbookFile(
      zipFixture(Buffer.from("hello"), { descriptorSize: 600 }),
    );
    await expect(profileFile(descriptor, "XLSX")).rejects.toThrow(
      /inconsistent ZIP metadata/i,
    );
    const checksum = await workbookFile(
      zipFixture(Buffer.from("hello"), { checksum: 0 }),
    );
    await expect(profileFile(checksum, "XLSX")).rejects.toThrow(
      /inconsistent ZIP metadata/i,
    );
  });
  it("rejects a later fake EOCD signature inside a ZIP comment", async () => {
    const archive = zipFixture(Buffer.from("hello"));
    archive.writeUInt16LE(22, archive.length - 2);
    const fakeEnd = Buffer.alloc(22);
    fakeEnd.writeUInt32LE(0x06054b50, 0);
    fakeEnd.writeUInt16LE(1, 20); // This later signature disagrees with the true EOF.
    const path = await workbookFile(Buffer.concat([archive, fakeEnd]));
    await expect(profileFile(path, "XLSX")).rejects.toThrow(
      /archive.*invalid|inconsistent ZIP metadata/i,
    );
  });
  it("rejects sparse dimensions that would require billions of cell visits", async () => {
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["id"], [1]]),
      "Sales",
    );
    const original = XLSX.write(book, {
      type: "buffer",
      bookType: "xlsx",
      compression: true,
    }) as Buffer;
    const cfb = XLSX.CFB.read(original, { type: "buffer" });
    const worksheet = cfb.FileIndex.find(
      (entry: { name: string }) => entry.name === "sheet1.xml",
    )!;
    const xml = Buffer.from(worksheet.content as Uint8Array).toString("utf8");
    worksheet.content = Buffer.from(
      xml.replace(
        /<dimension ref="[^"]*"\s*\/>/,
        '<dimension ref="A1:NTP1000001"/>',
      ),
    );
    worksheet.size = worksheet.content.length;
    const path = await workbookFile(
      XLSX.CFB.write(cfb, {
        type: "buffer",
        fileType: "zip",
        compression: true,
      }) as Buffer,
    );
    await expect(profileFile(path, "XLSX")).rejects.toThrow(
      /2,000,000 cell profiling budget/i,
    );
  });
  it("rejects invalid workbook archives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dataforge-workbook-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "bad.xlsx");
    await writeFile(path, "not a spreadsheet");
    await expect(profileFile(path, "XLSX")).rejects.toThrow(
      /archive|workbook/i,
    );
  });
});
