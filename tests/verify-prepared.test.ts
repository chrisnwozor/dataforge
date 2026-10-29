import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { computePreparedReference } from "@/lib/verify/prepared";
import type { VerificationColumn } from "@/lib/verify/types";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "df-verify-prepared-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const columns: VerificationColumn[] = [
  { id: "0", name: "ID", type: "text" },
  { id: "1", name: "Sales", type: "decimal" },
  { id: "2", name: "Quantity", type: "integer" },
  { id: "3", name: "Date", type: "date" },
  { id: "4", name: "Active", type: "boolean" },
  { id: "5", name: "Region", type: "text" },
];
async function csv(contents: string) {
  const file = join(directory, "prepared.csv");
  await writeFile(file, contents);
  return file;
}

describe("independent streaming prepared references", () => {
  it("reconciles exact decimal totals and deduplicated statistics against a separate integer-cent calculation", async () => {
    const file = await csv(
      "ID,Sales,Quantity,Date,Active,Region\nA,0.10,2,2024-01-01,yes,East\nB,0.20,3,1/2/2024,false,West\nB,0.20,3,1/2/2024,false,West\nC,,0,,1,\n",
    );
    const result = await computePreparedReference(file, columns, {
      dimensionTuples: { place: ["Region", "Active"] },
    });
    // This independent oracle adds integer cents, not the reference's decimal accumulator.
    const cents = [10, 20, 20],
      dedupCents = [10, 20];
    expect(result.rows).toBe(4);
    expect(result.uniqueRows).toBe(3);
    expect(result.duplicateRows).toBe(1);
    expect(result.nullCells).toBe(3);
    expect(result.columns[1].numeric).toEqual({
      count: 3,
      nulls: 1,
      sum: cents.reduce((a, b) => a + b, 0) / 100,
      min: 0.1,
      max: 0.2,
    });
    expect(result.deduplicatedColumns[1].numeric?.sum).toBe(
      dedupCents.reduce((a, b) => a + b, 0) / 100,
    );
    expect(result.deduplicatedColumns[2].numeric?.sum).toBe(2 + 3 + 0);
    expect(result.columns[3]).toMatchObject({
      distinct: 2,
      min: "2024-01-01",
      max: "2024-01-02",
      nulls: 1,
    });
    expect(result.columns[4]).toMatchObject({ distinct: 2, nulls: 0 });
    expect(result.distinctTuples.place).toBe(2);
    expect(result.warnings).toEqual([]);
  });
  it("handles BOM, quoted newlines, grouped/exponent numbers, canonical numeric distinctness, and trimmed NULL/duplicate semantics", async () => {
    const selected = [columns[0], columns[1]];
    const file = await csv(
      '\uFEFFID,Sales\n" First\nLast ","1,000.50"\nX,1e-1\nY,0.10\n X ,1e-1\n',
    );
    const value = await computePreparedReference(file, selected);
    expect(value.rows).toBe(4);
    expect(value.duplicateRows).toBe(1);
    expect(value.columns[1]).toMatchObject({
      distinct: 2,
      numeric: { sum: 1000.8, min: 0.1, max: 1000.5 },
    });
    expect(value.deduplicatedColumns[1].numeric?.sum).toBe(1000.7);
  });
  it("does not confuse a typed-equivalent value with an exact raw duplicate", async () => {
    const file = await csv("ID,Sales\nA,1.0\nA,1.00\nA,1e0\n");
    const value = await computePreparedReference(file, [
      columns[0],
      columns[1],
    ]);
    expect(value.duplicateRows).toBe(0);
    expect(value.columns[1].distinct).toBe(1);
    expect(value.columns[1].numeric?.sum).toBe(3);
  });
  it("reports invalid typed values and unsafe integer precision without treating them as NULL or silently rounding a passing reference", async () => {
    const file = await csv(
      "ID,Quantity,Date,Active\nA,invalid,2023-02-29,perhaps\nB,9007199254740993,2024-02-29,true\n",
    );
    const value = await computePreparedReference(file, [
      columns[0],
      columns[2],
      columns[3],
      columns[4],
    ]);
    expect(value.columns[1].nulls).toBe(0);
    expect(value.columns[1].distinct).toBe(2);
    expect(value.warnings.join(" ")).toContain(
      "invalid for its saved integer type",
    );
    expect(value.warnings.join(" ")).toContain(
      "exceeds exact JavaScript numeric precision",
    );
    expect(value.columns[2].min).toBe("2024-02-29");
    expect(value.warnings.join(" ")).toContain(
      "invalid for its saved date type",
    );
    expect(value.warnings.join(" ")).toContain(
      "invalid for its saved boolean type",
    );
  });
  it("supports header-only prepared output and single-column all-empty observations", async () => {
    const header = await csv("ID\n");
    expect(await computePreparedReference(header, [columns[0]])).toMatchObject({
      rows: 0,
      uniqueRows: 0,
      nullCells: 0,
    });
    const empty = await csv("ID\n\n\n");
    expect(await computePreparedReference(empty, [columns[0]])).toMatchObject({
      rows: 2,
      duplicateRows: 1,
      nullCells: 2,
    });
  });
  it("fails clearly on budget limits, schema drift, malformed CSV and unreadable files", async () => {
    const file = await csv("ID\nAlpha\nBeta\nGamma\n");
    await expect(
      computePreparedReference(file, [columns[0]], { memoryBytes: 1 }),
    ).rejects.toThrow(/memory budget/i);
    await expect(
      computePreparedReference(file, [columns[0]], { memoryBytes: 450 }),
    ).rejects.toThrow(/exact checks never substitute/i);
    await expect(
      computePreparedReference(file, [columns[0]], { memoryBytes: 0 }),
    ).rejects.toThrow(/between/i);
    await expect(computePreparedReference(file, [columns[1]])).rejects.toThrow(
      /headers/,
    );
    await expect(
      computePreparedReference(file, [columns[0]], {
        dimensionTuples: { missing: ["No column"] },
      }),
    ).rejects.toThrow(/unavailable/);
    await expect(
      computePreparedReference(file, [columns[0], columns[0]]),
    ).rejects.toThrow(/unique/);
    const malformed = await csv('ID\n"bad');
    await expect(
      computePreparedReference(malformed, [columns[0]]),
    ).rejects.toThrow(/independent prepared CSV pass failed/);
    await expect(
      computePreparedReference(join(directory, "absent.csv"), [columns[0]]),
    ).rejects.toThrow(/independent prepared CSV pass failed/);
  });
  it("honours cancellation and rejects inconsistent prepared rows", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled independently"));
    await expect(
      computePreparedReference("not opened", [columns[0]], {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled independently/);
    const file = await csv("ID,Sales\nA,2\nB\n");
    await expect(
      computePreparedReference(file, [columns[0], columns[1]]),
    ).rejects.toThrow(/CSV/);
  });
  it("reconciles the checked-in Superstore sample against an independent cents oracle and exposes the requested fixture discrepancy", async () => {
    const path = join(process.cwd(), "samples/superstore_sales.csv");
    const raw = parse(await readFile(path), { columns: true }) as Record<
      string,
      string
    >[];
    const sourceColumns = Object.keys(raw[0]).map(
      (name, index): VerificationColumn => ({
        id: String(index),
        name,
        type: ["Sales", "Profit", "Discount"].includes(name)
          ? "decimal"
          : name === "Quantity"
            ? "integer"
            : name === "Order Date"
              ? "date"
              : "text",
      }),
    );
    const value = await computePreparedReference(path, sourceColumns);
    const exact = (name: string) =>
      raw.reduce(
        (sum, row) => sum + Math.round(Number(row[name] || "0") * 100),
        0,
      ) / 100;
    expect(value.rows).toBe(raw.length);
    expect(
      value.columns.find((column) => column.name === "Sales")?.numeric?.sum,
    ).toBe(exact("Sales"));
    expect(exact("Sales")).toBe(1485523.86);
    expect(exact("Profit")).toBe(208556.86);
    expect(exact("Sales")).not.toBe(1895524.97);
    const duplicated = join(directory, "with-three-duplicates.csv");
    const original = await readFile(path, "utf8");
    await writeFile(
      duplicated,
      original.trimEnd() +
        "\n" +
        original.trimEnd().split("\n").slice(1, 4).join("\n") +
        "\n",
    );
    const withDuplicates = await computePreparedReference(
      duplicated,
      sourceColumns,
    );
    expect(withDuplicates).toMatchObject({
      rows: 2003,
      uniqueRows: 2000,
      duplicateRows: 3,
    });
    expect(
      withDuplicates.deduplicatedColumns.find(
        (column) => column.name === "Sales",
      )?.numeric?.sum,
    ).toBe(exact("Sales"));
  });
});
