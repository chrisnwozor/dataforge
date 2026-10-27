import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { POST as upload } from "@/app/api/projects/route";
import { cleanedSourceResponse } from "@/lib/server/cleaned-source";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { projectUploadDirectory } from "@/lib/server/projects";
import type { CreateProjectResponse } from "@/lib/server/uploads";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "dataforge-cleaned-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(async () => {
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function create(contents: string | Uint8Array, name = "source.csv") {
  const form = new FormData();
  form.set("name", "Cleaned source");
  form.set(
    "file",
    new File(
      [typeof contents === "string" ? contents : Uint8Array.from(contents)],
      name,
    ),
  );
  const response = await upload(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as CreateProjectResponse;
}

describe("cleaned source downloads", () => {
  it.each([",", ";", "\t"])(
    "converts a BOM %j-delimited source into quoted comma UTF-8 LF without extra columns",
    async (delimiter) => {
      const contents = `\uFEFFName${delimiter}Notes${delimiter}Value\r\n"München, DE"${delimiter}"first\r\nsecond with ""quotes"""${delimiter}12.50\r\n  Alice  ${delimiter}"  keep padding  "${delimiter}20\r\n`;
      const { project } = await create(contents);
      const response = await cleanedSourceResponse(project.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="source_cleaned.csv"',
      );
      expect(response.headers.has("content-length")).toBe(false);
      const body = await response.text();
      expect(body.startsWith("\uFEFF")).toBe(false);
      expect(body).not.toContain("\r");
      expect(body.endsWith("\n")).toBe(true);
      expect(parse(body)).toEqual([
        ["Name", "Notes", "Value"],
        ["München, DE", 'first\nsecond with "quotes"', "12.50"],
        ["Alice", "  keep padding  ", "20"],
      ]);
    },
  );

  it("pads short records and ignores extra fields exactly as profiling does", async () => {
    const { project, profile } = await create(
      "ID,Name,Value\n1,Alice,4\n2\n3,Bob,5,ignored\n",
    );
    const body = await (await cleanedSourceResponse(project.id)).text();
    expect(profile.raggedRowCount).toBe(2);
    expect(parse(body)).toEqual([
      ["ID", "Name", "Value"],
      ["1", "Alice", "4"],
      ["2", "", ""],
      ["3", "Bob", "5"],
    ]);
    expect(parse(body).every((row: string[]) => row.length === 3)).toBe(true);
  });

  it("exports the real 2,000-row sample, keeping the 11 source columns", async () => {
    const sample = await readFile(
      join(process.cwd(), "samples", "superstore_sales.csv"),
    );
    const { project } = await create(sample, "superstore_sales.csv");
    const records = parse(
      await (await cleanedSourceResponse(project.id)).text(),
    ) as string[][];
    expect(records).toHaveLength(2001);
    expect(records[0]).toHaveLength(11);
    expect(records[0]).not.toContain("source_row_number");
    expect(records[1][5]).toBe("Bookcase, 3-Shelf");
  });

  it("exports a validated first XLSX worksheet as CSV with ISO dates and raw numeric values", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["ID", "Date", "Notes", "Sales"],
        [1, new Date("2024-02-29T00:00:00.000Z"), 'a,b\r\n"quoted"', 12.5],
        [2, new Date("2024-03-01T00:00:00.000Z"), " plain ", 20],
      ]),
      "Source",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Wrong"], ["Ignore"]]),
      "Later",
    );
    const { project } = await create(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer,
      "sales.xlsx",
    );
    const response = await cleanedSourceResponse(project.id);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="sales_cleaned.csv"',
    );
    expect(parse(await response.text())).toEqual([
      ["ID", "Date", "Notes", "Sales"],
      ["1", "2024-02-29T00:00:00.000Z", 'a,b\n"quoted"', "12.5"],
      ["2", "2024-03-01T00:00:00.000Z", " plain ", "20"],
    ]);
  });

  it("cancels a large export after the header and releases the retained file", async () => {
    const { project } = await create("ID,Value\n1,small\n");
    const path = join(projectUploadDirectory(project.id), project.sourceFile);
    await writeFile(
      path,
      "ID,Value\n" +
        "1," +
        "x".repeat(200) +
        "\n" +
        ("2," + "y".repeat(200) + "\n").repeat(100_000),
    );
    const response = await cleanedSourceResponse(project.id);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString("utf8")).toBe("ID,Value\n");
    await reader.cancel();
    // On Windows this also proves no lingering open read handle prevents deletion.
    await rm(path);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed retained text instead of silently emitting a partial valid-looking export", async () => {
    const { project } = await create("ID,Value\n1,ok\n");
    const path = join(projectUploadDirectory(project.id), project.sourceFile);
    await writeFile(path, 'ID,Value\n1,"unterminated');
    try {
      const response = await cleanedSourceResponse(project.id);
      await expect(response.text()).rejects.toBeInstanceOf(Error);
    } catch (error) {
      expect(error).toMatchObject({ status: 422 });
    }
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x41, 0, 0x42, 0]));
    await expect(cleanedSourceResponse(project.id)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("validates IDs and confines both stored paths and symlink targets", async () => {
    await expect(cleanedSourceResponse("../outside")).rejects.toMatchObject({
      status: 400,
    });
    await expect(cleanedSourceResponse(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
    const { project } = await create("ID\n1\n2\n");
    getDatabase()
      .prepare("UPDATE projects SET source_file = ? WHERE id = ?")
      .run("../outside.csv", project.id);
    await expect(cleanedSourceResponse(project.id)).rejects.toMatchObject({
      status: 422,
    });
    getDatabase()
      .prepare("UPDATE projects SET source_file = ? WHERE id = ?")
      .run("source.csv", project.id);
    const outside = join(directory, "outside.csv");
    await writeFile(outside, "secret\nvalue\n");
    const path = join(projectUploadDirectory(project.id), "source.csv");
    await rm(path);
    try {
      await symlink(outside, path);
    } catch (error) {
      // Windows may require Developer Mode for symlink creation.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(cleanedSourceResponse(project.id)).rejects.toMatchObject({
      status: 422,
    });
  });
});
