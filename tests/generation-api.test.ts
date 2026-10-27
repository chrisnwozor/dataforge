import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { POST as upload } from "@/app/api/projects/route";
import { GET as generate } from "@/app/api/projects/[id]/generate/route";
import { GET as zip } from "@/app/api/projects/[id]/generate/zip/route";
import { GET as cleaned } from "@/app/api/projects/[id]/source/cleaned/route";
import {
  getGeneration,
  type GenerationResponse,
} from "@/lib/server/generation";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { readSavedModel, saveEditedModel } from "@/lib/server/models";
import {
  ensureProjectEvidence,
  findProject,
  readColumnProfiles,
  readProfileReport,
  updateColumnOverrides,
} from "@/lib/server/projects";
import type { CreateProjectResponse } from "@/lib/server/uploads";
import { profileFile } from "@/lib/profiler";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-generate-api-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (query = "") =>
  new Request(`http://localhost/api/projects/id/generate${query}`);
const basicCsv =
  "Order ID,Customer Name,Segment,Region,Sales\nO-1,Alice,Consumer,East,12.30\nO-2,Bob,Corporate,West,21.60\nO-3,Alice,Consumer,West,12.30\nO-4,Bob,Corporate,East,21.60\n";
async function create(
  contents = basicCsv,
  filename = "sales.csv",
): Promise<CreateProjectResponse> {
  const form = new FormData();
  form.set("name", "Actual sales");
  form.set("file", new File([contents], filename, { type: "text/csv" }));
  const response = await upload(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<CreateProjectResponse>;
}
async function generated(id: string, query = ""): Promise<GenerationResponse> {
  const response = await generate(request(query), context(id));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<GenerationResponse>;
}

describe("real SQL generation API", () => {
  it("generates all six files from the saved Superstore model and exact profiles", async () => {
    const { project } = await create(
      readFileSync(join(process.cwd(), "samples/superstore_sales.csv"), "utf8"),
      "superstore_sales.csv",
    );
    const result = await generated(project.id);
    expect(result.files.map((file) => file.name)).toEqual([
      "00_setup.sql",
      "01_staging.sql",
      "02_dim_date.sql",
      "03_dimensions.sql",
      "04_fact.sql",
      "05_checks.sql",
    ]);
    expect(
      result.validation.filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(result.options).toEqual({
      incremental: false,
      dedupe: false,
      database: "DataForge",
    });
    expect(result.savedDedupe).toBe(false);
    expect(result.model.fact.name).toBe("fact_sales");
    expect(result.files[1].sql).toContain("[stg].[superstore_sales]");
    expect(result.files[4].sql).toContain("[dw].[fact_sales]");
    for (const file of result.files) {
      expect(file.description.length).toBeGreaterThan(20);
      expect(file.sql).toContain("Review before running");
    }
    expect(result.files[4].sql.match(/FOREIGN KEY/g)).toHaveLength(4);
    expect(readSavedModel(project.id)?.source).toBe("suggested");
    expect(findProject(project.id)?.rowCount).toBe(2000);
    expect(
      readColumnProfiles(project.id).every(
        (column) => typeof column.maxLength === "number",
      ),
    ).toBe(true);
  });

  it("honors current options and never mutates the shared dedupe flag on GET", async () => {
    const { project } = await create();
    const initial = await generated(project.id);
    initial.model.removeExactDuplicates = true;
    saveEditedModel(project.id, initial.model);
    const saved = readSavedModel(project.id)!;
    expect((await generated(project.id)).options.dedupe).toBe(true);
    const db = "Warehouse ]; DROP DATABASE other; --";
    const preview = await generated(
      project.id,
      `?incremental=true&dedupe=false&db=${encodeURIComponent(db)}`,
    );
    expect(preview.options).toEqual({
      incremental: true,
      dedupe: false,
      database: db,
    });
    expect(preview.files[0].sql).toContain(
      "USE [Warehouse ]]; DROP DATABASE other; --];",
    );
    expect(preview.validation.map((issue) => issue.code)).toContain(
      "incremental-without-date",
    );
    expect(readSavedModel(project.id)).toEqual(saved);
  });

  it("downloads a ZIP containing the same generated UTF-8 SQL files", async () => {
    const { project } = await create();
    const result = await generated(
      project.id,
      "?db=ExampleWarehouse&dedupe=true",
    );
    const response = await zip(
      request("?db=ExampleWarehouse&dedupe=true"),
      context(project.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      "dataforge-sql.zip",
    );
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(archive)).toEqual(result.files.map((file) => file.name));
    for (const file of result.files)
      expect(strFromU8(archive[file.name])).toBe(file.sql);
  });

  it("keeps invalid drafts visible but blocks SQL downloads", async () => {
    const { project } = await create();
    const first = await generated(project.id);
    first.model.fact.grain = "";
    saveEditedModel(project.id, first.model);
    const invalid = await generated(project.id);
    expect(invalid.files).toEqual([]);
    expect(invalid.validation.map((issue) => issue.code)).toContain(
      "missing-grain",
    );
    const response = await zip(request(), context(project.id));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("validation errors");
  });

  it("blocks incompatible profile edits and missing model relationships", async () => {
    const { project } = await create();
    const first = await generated(project.id);
    updateColumnOverrides(project.id, [{ ordinal: 4, type: "text" }]);
    const changedType = await generated(project.id);
    expect(changedType.files).toEqual([]);
    expect(changedType.validation.map((issue) => issue.code)).toContain(
      "incompatible-measure-type",
    );
    updateColumnOverrides(project.id, [{ ordinal: 4, type: null }]);
    first.model.fact.foreignKeys = [];
    saveEditedModel(project.id, first.model);
    const missingLinks = await generated(project.id);
    expect(missingLinks.files).toEqual([]);
    expect(missingLinks.validation.map((issue) => issue.code)).toContain(
      "missing-dimension-link",
    );
  });

  it("requires date links and date types for a generated calendar", async () => {
    const { project } = await create(
      "Order ID,Order Date,Sales\nO-1,2024-01-01,12\nO-2,2024-01-02,21\nO-3,2024-01-01,12\n",
    );
    const first = await generated(project.id);
    expect(first.files).toHaveLength(6);
    updateColumnOverrides(project.id, [{ ordinal: 1, type: "text" }]);
    expect(
      (await generated(project.id)).validation.map((issue) => issue.code),
    ).toContain("incompatible-date-type");
    updateColumnOverrides(project.id, [{ ordinal: 1, type: null }]);
    first.model.fact.foreignKeys = [];
    saveEditedModel(project.id, first.model);
    expect(
      (await generated(project.id)).validation.map((issue) => issue.code),
    ).toContain("missing-date-link");
  });

  it("blocks incremental loads when the source date has no persisted model anchor", async () => {
    const { project } = await create(
      "Order ID,Order Date,Sales\nO-1,2024-01-01,12\nO-2,2024-01-02,21\nO-3,2024-01-01,12\n",
    );
    const first = await generated(project.id);
    const calendars = new Set(
      first.model.dimensions
        .filter((dimension) => dimension.generated === "date")
        .map((dimension) => dimension.id),
    );
    first.model.dimensions = first.model.dimensions.filter(
      (dimension) => !calendars.has(dimension.id),
    );
    first.model.fact.foreignKeys = first.model.fact.foreignKeys.filter(
      (key) => !calendars.has(key.dimensionId),
    );
    first.model.unassigned.push("1");
    saveEditedModel(project.id, first.model);
    const incremental = await generated(project.id, "?incremental=true");
    expect(incremental.files).toEqual([]);
    expect(incremental.validation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "incremental-date-unassigned",
          severity: "error",
        }),
      ]),
    );
    expect(
      (await zip(request("?incremental=true"), context(project.id))).status,
    ).toBe(409);
    expect((await generated(project.id)).files).toHaveLength(6);
  });

  it("blocks wide validation work tables before producing unusable SQL", async () => {
    const headings = Array.from(
      { length: 512 },
      (_, index) => `measure_${index}`,
    );
    const zeroes = headings.map(() => "0").join(",");
    const ones = headings.map(() => "1").join(",");
    const { project } = await create(
      [headings.join(","), zeroes, ones, zeroes, ones].join("\n"),
    );
    const result = await generated(project.id);
    expect(result.validation.map((issue) => issue.code)).toContain(
      "conversion-column-limit",
    );
    expect(result.files).toEqual([]);
    expect((await zip(request(), context(project.id))).status).toBe(409);
  });

  it("validates query values, duplicate options, IDs, and database names", async () => {
    const { project } = await create();
    for (const query of [
      "?incremental=maybe",
      "?dedupe=",
      "?dedupe=true&dedupe=false",
      "?db=",
      "?db=" + encodeURIComponent("bad\nname"),
      "?db=" + "x".repeat(129),
      "?unexpected=1",
    ]) {
      expect(
        (await generate(request(query), context(project.id))).status,
        query,
      ).toBe(400);
      expect(
        (await zip(request(query), context(project.id))).status,
        query,
      ).toBe(400);
    }
    expect((await generate(request(), context("invalid"))).status).toBe(400);
    expect((await generate(request(), context(randomUUID()))).status).toBe(404);
    expect((await cleaned(request(), context("invalid"))).status).toBe(400);
    expect((await cleaned(request(), context(randomUUID()))).status).toBe(404);
  });

  it("captures complete raw sizing and scale, then backfills Phase 2 imports without losing edits", async () => {
    const longText = " " + "🧱".repeat(35) + " ";
    const contents = `ID,Label,Amount\n1,a,1.20\n2,b,1.20\n3,c,1.20\n4,d,1.20\n5,e,1.20\n6,"${longText}",1.23456789\n7,f,4e-5\n8,g,"1,234.1234"\n`;
    const { project } = await create(contents);
    const direct = await profileFile(
      join(directory, "uploads", project.id, "sales.csv"),
      "CSV",
    );
    expect(direct.columns[1].maxLength).toBe(72);
    expect(direct.columns[2].maxDecimalPlaces).toBe(6);
    const first = await generated(project.id);
    first.model.fact.name = "fact_preserved";
    first.model.removeExactDuplicates = true;
    saveEditedModel(project.id, first.model);
    updateColumnOverrides(project.id, [{ ordinal: 0, type: "text" }]);
    const saved = readSavedModel(project.id)!;
    const timestamp = findProject(project.id)!.updatedAt;
    getDatabase()
      .prepare(
        "UPDATE column_profiles SET max_length=NULL,max_decimal_places=NULL WHERE project_id=?",
      )
      .run(project.id);
    const report = readProfileReport(project.id);
    writeFileSync(
      join(directory, "uploads", project.id, "profile-report.json"),
      JSON.stringify({ ...report, evidenceVersion: 2 }),
    );
    closeDatabase();
    await ensureProjectEvidence(project.id);
    expect(readProfileReport(project.id).evidenceVersion).toBe(3);
    expect(readColumnProfiles(project.id)[1].maxLength).toBe(72);
    expect(readColumnProfiles(project.id)[2].maxDecimalPlaces).toBe(6);
    expect(readColumnProfiles(project.id)[0].overrideType).toBe("text");
    expect(readSavedModel(project.id)).toEqual(saved);
    expect(findProject(project.id)!.updatedAt).toBe(timestamp);
    const output = await getGeneration(project.id);
    expect(output.files[1].sql).toContain("NVARCHAR(90)");
  });
});
