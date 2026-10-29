import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSource, readSourceRows, sourceOptionsSchema, uniqueSourceHeaders, workbookSheetNames, type SourceFile } from "@/lib/prepare/readers";
import { flattenJsonObject, readJsonRows } from "@/lib/prepare/json-reader";
import { pipelineDefinitionSchema } from "@/lib/prepare/schema";
import { executePipeline } from "@/lib/prepare/engine";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "dataforge-source-readers-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function file(name: string, contents: string | Uint8Array, options: unknown = {}): Promise<SourceFile> {
  const path = join(directory, name); await writeFile(path, contents);
  return { filePath: path, kind: name.endsWith("xlsx") ? "xlsx" : name.endsWith("json") ? "json" : "csv", options: sourceOptionsSchema.parse(options) };
}
async function collect(source: SourceFile, limit?: number) { const rows = []; for await (const row of readSourceRows(source, { limit })) rows.push(row); return rows; }

describe("bounded source readers", () => {
  it("streams CSV with BOM, quoted delimiters/newlines, empty fields and ragged rows", async () => {
    const source = await file("sales.csv", '\uFEFFName;Category;Sales\n" Alex; Morgan ";"Office\nSupplies";25.5\nJamie;;10\nPat\n');
    const result = await analyzeSource(source);
    expect(result.rowCount).toBe(3);
    expect(result.columns).toEqual([{ name: "Name", type: "text" }, { name: "Category", type: "text" }, { name: "Sales", type: "decimal" }]);
    expect(result.preview[0]).toEqual({ Name: " Alex; Morgan ", Category: "Office\nSupplies", Sales: "25.5" });
    expect(result.preview[1]).toEqual({ Name: "Jamie", Category: null, Sales: "10" });
    expect(result.preview[2]).toEqual({ Name: "Pat", Category: null, Sales: null });
    expect(result.warnings).toHaveLength(1);
  });
  it("supports header-row selection and deterministic unique source column names", async () => {
    const source = await file("headers.csv", "Export generated,,,,\nName,Name,,Sales\nAlex,Morgan,West,10\n", { headerRow: 2, delimiter: "," });
    expect(await collect(source)).toEqual([{ Name: "Alex", "Name (2)": "Morgan", "Column 3": "West", Sales: "10" }]);
    expect(uniqueSourceHeaders(["Name", "Name", "Name (2)"])).toEqual(["Name", "Name (2)", "Name (2) (2)"]);
  });
  it("CSV previews stop at the sample before a malformed tail", async () => {
    const source = await file("preview.csv", "Name,Sales\n" + Array.from({ length: 1000 }, (_, index) => `Name${index},${index}`).join("\n") + '\n"unterminated');
    expect(await collect(source, 1000)).toHaveLength(1000);
    await expect(collect(source)).rejects.toThrow();
  });
  it("rejects externally changed headers while allowing missing fields in sparse JSON records", async () => {
    const source = await file("changed.csv", "Renamed,Sales\nAlex,10\n");
    await expect(async () => { for await (const row of readSourceRows(source, { expectedColumns: ["Name", "Sales"] })) void row; }).rejects.toThrow("headers changed outside DataForge");
    const sparse = await file("sparse.json", '[{"Name":"Alex"},{"Sales":10}]');
    const rows = []; for await (const row of readSourceRows(sparse, { expectedColumns: ["Name", "Sales"] })) rows.push(row);
    expect(rows).toEqual([{ Name: "Alex" }, { Sales: 10 }]);
    await expect(async () => { for await (const row of readSourceRows(sparse, { expectedColumns: ["Name"] })) void row; }).rejects.toThrow("new columns");
  });
  it("rejects invalid encodings, empty/control-character headers, and honours cancellation", async () => {
    const utf16 = await file("utf16.csv", new Uint8Array([0xff, 0xfe, 65, 0]));
    await expect(collect(utf16)).rejects.toThrow("UTF-8");
    const bad = await file("bad.csv", "Name\u0001,Sales\nA,2\n");
    await expect(collect(bad)).rejects.toThrow("control characters");
    expect(() => uniqueSourceHeaders(["", ""])).toThrow("header");
    const normal = await file("normal.csv", "Name\nAlex\n");
    const controller = new AbortController(); controller.abort();
    await expect(async () => { for await (const row of readSourceRows(normal, { signal: controller.signal })) void row; }).rejects.toThrow();
  });
  it("JSON flattens nested objects, joins scalar arrays, ignores object arrays with a warning", async () => {
    const source = await file("orders.json", JSON.stringify({ meta: { export: "test" }, data: { orders: [{ id: 1, customer: { name: " Alex " }, tags: ["new", "web", null], details: [{ sku: "A" }] }, { id: 2, customer: { name: "Pat", segment: "Retail" }, active: true }] } }), { jsonArrayPath: "$.data.orders", arraySeparator: ", " });
    const result = await analyzeSource(source);
    expect(result.rowCount).toBe(2);
    expect(result.preview[0]).toEqual({ id: 1, "customer.name": " Alex ", tags: "new, web, " });
    expect(result.columns.map((column) => column.name)).toEqual(["id", "customer.name", "tags", "customer.segment", "active"]);
    expect(result.warnings[0]).toContain("Ignored array of objects in details");
    expect(flattenJsonObject({ "__proto__": null, constructor: "safe", bool: false })).toMatchObject({ constructor: "safe", bool: false });
  });
  it("JSON previews parse only the selected sample and do not inspect a malformed trailing document", async () => {
    const source = await file("preview.json", '{"data":{"orders":[' + Array.from({ length: 1000 }, (_, index) => JSON.stringify({ id: index })).join(",") + ", definitely invalid tail");
    expect(await collect({ ...source, options: sourceOptionsSchema.parse({ jsonArrayPath: "data.orders" }) }, 1000)).toHaveLength(1000);
    await expect(collect({ ...source, options: sourceOptionsSchema.parse({ jsonArrayPath: "data.orders" }) })).rejects.toThrow("Invalid JSON");
  });
  it("preserves large JSON integer identifiers and never assigns object prototypes", async () => {
    const source = await file("identifiers.json", '[{"id":9007199254740993,"__proto__":{"polluted":true}}]');
    expect(await collect(source)).toEqual([{ id: "9007199254740993", "__proto__.polluted": true }]);
    expect({}).not.toHaveProperty("polluted");
  });
  it("rejects JSON scalar rows, ambiguous flattened columns, invalid paths, huge rows and nesting", async () => {
    const scalar = await file("scalar.json", '[1,{"id":2}]');
    await expect(collect(scalar)).rejects.toThrow("must be an object");
    expect(() => flattenJsonObject({ a: { b: 1 }, "a.b": 2 })).toThrow("collide");
    const missing = await file("missing.json", '{"data":[]}');
    await expect(collect({ ...missing, options: sourceOptionsSchema.parse({ jsonArrayPath: "absent" }) })).rejects.toThrow("does not exist");
    const deep: Record<string, unknown> = {}; let cursor = deep; for (let index = 0; index < 35; index++) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
    expect(() => flattenJsonObject(deep)).toThrow("32 levels");
    const huge = await file("huge.json", JSON.stringify([{ text: "x".repeat(2 * 1024 * 1024 + 1) }]));
    await expect(collect(huge)).rejects.toThrow("2 MB");
  });
  it("reads XLSX sheets separately with header-row selection, ISO dates and bounded previews", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Export", null, null], ["Product ID", "Product", "Price"], ["P1", "desk", 100], ["P2", "CHAIR", 50]]), "Products");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Date", "Active"], [new Date("2024-02-29T00:00:00Z"), true], [new Date("2024-03-01T13:45:00Z"), false]]), "Calendar");
    const source = await file("products.xlsx", XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), { sheetName: "Products", headerRow: 2 });
    expect(await workbookSheetNames(source.filePath)).toEqual(["Products", "Calendar"]);
    expect(await collect(source, 1)).toEqual([{ "Product ID": "P1", Product: "desk", Price: 100 }]);
    expect((await analyzeSource(source)).rowCount).toBe(2);
    expect(await collect({ ...source, options: sourceOptionsSchema.parse({ sheetName: "Calendar" }) }, 1)).toEqual([{ Date: "2024-02-29T00:00:00.000Z", Active: true }]);
    expect((await collect({ ...source, options: sourceOptionsSchema.parse({ sheetName: "Calendar" }) }, 2))[1].Date).toBe("2024-03-01T13:45:00.000Z");
    await expect(collect({ ...source, options: sourceOptionsSchema.parse({ sheetName: "missing" }) })).rejects.toThrow("no longer exists");
  });
  it("rejects corrupt or expanded-range XLSX files with the existing ZIP safety checks", async () => {
    const corrupt = await file("corrupt.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    await expect(workbookSheetNames(corrupt.filePath)).rejects.toThrow();
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([["Name"], ["Alex"]]);
    XLSX.utils.book_append_sheet(book, sheet, "Wide");
    const archive = unzipSync(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
    archive["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(archive["xl/worksheets/sheet1.xml"]).replace('ref="A1:A2"', 'ref="A1:ZZZ1000"'));
    const huge = await file("wide.xlsx", zipSync(archive));
    await expect(collect(huge, 1)).rejects.toThrow("budget");
  });
  it("readJsonRows closes a cancelled or early-stopped file cleanly", async () => {
    const source = await file("cancel.json", JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ id }))));
    const controller = new AbortController(); const iterator = readJsonRows(source.filePath, { signal: controller.signal });
    expect((await iterator.next()).value).toEqual({ id: 0 }); controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    const early = readJsonRows(source.filePath); await early.next(); await early.return(undefined);
    await expect(rm(source.filePath)).resolves.toBeUndefined();
  });
  it("runs the documented orders/customer/product example through the same preview and full engine", async () => {
    const definition = pipelineDefinitionSchema.parse(JSON.parse(await readFile(join(process.cwd(), "samples/prepare-example.json"), "utf8")));
    const inputs = await Promise.all([[
      "orders", "orders.csv", {},
    ], ["customers", "customers.csv", {}], ["products", "products.xlsx", { sheetName: "Products" }]].map(async ([id, name, options]) => {
      const source: SourceFile = { filePath: join(process.cwd(), "samples", String(name)), kind: String(name).endsWith("xlsx") ? "xlsx" : "csv", options: sourceOptionsSchema.parse(options) };
      const analysis = await analyzeSource(source);
      return { id: String(id), columns: analysis.columns.map((column) => column.name), open: (request?: { limit?: number; signal?: AbortSignal }) => readSourceRows(source, request) };
    }));
    const full = await executePipeline(definition, inputs), sampled = await executePipeline(definition, inputs, { sourceLimit: 1000 });
    const fullRows = [], previewRows = [];
    try {
      for await (const row of full.rows) fullRows.push(row);
      for await (const row of sampled.rows) previewRows.push(row);
      expect(previewRows).toEqual(fullRows); expect(fullRows).toHaveLength(6);
      expect(fullRows[0]).toMatchObject({ "Order ID": "O-1001", "Customer Name": "Alex Morgan", Product: "Standing Desk", Sales: 799, Profit: 319 });
      expect(full.columns).toHaveLength(11); expect(full.summary.rowsRejected).toBe(2);
      expect(full.summary.steps.find((step) => step.id === "dedupe-orders")?.removed).toBe(1);
    } finally { await full.close(); await sampled.close(); }
  });
});
