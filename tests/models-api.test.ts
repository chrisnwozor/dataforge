import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { POST as upload } from "@/app/api/projects/route";
import { GET, PUT } from "@/app/api/projects/[id]/model/route";
import { POST as suggest } from "@/app/api/projects/[id]/model/suggest/route";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  ensureProjectEvidence,
  findProject,
  readColumnProfiles,
  readProfileReport,
  updateColumnOverrides,
} from "@/lib/server/projects";
import {
  createModelSuggestion,
  readSavedModel,
  type SavedModel,
} from "@/lib/server/models";
import type { CreateProjectResponse } from "@/lib/server/uploads";
import { getProject, getProjects } from "@/lib/data";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-model-api-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const csv =
  "Order ID,Customer Name,Segment,Region,Sales\nO-1,Alice,Consumer,East,12\nO-2,Bob,Corporate,West,21\nO-3,Alice,Consumer,East,12\nO-4,Bob,Corporate,West,21\n";
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = () => new Request("http://localhost/api/projects/id/model");
const put = (value: unknown) =>
  new Request("http://localhost/api/projects/id/model", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });

async function create(contents = csv): Promise<CreateProjectResponse> {
  const form = new FormData();
  form.set("name", "Stored sales");
  form.set("file", new File([contents], "sales.csv", { type: "text/csv" }));
  const response = await upload(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<CreateProjectResponse>;
}

async function saved(id: string): Promise<SavedModel> {
  const response = await GET(request(), context(id));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<SavedModel>;
}

describe("persisted model API", () => {
  it("stores the first suggestion once and reads it across a database reopen", async () => {
    const { project } = await create();
    expect(readSavedModel(project.id)).toBeUndefined();
    const first = await saved(project.id);
    expect(first.source).toBe("suggested");
    expect(first.model.fact.name).toBe("fact_sales");
    expect(first.model.fact.measures.map((measure) => measure.name)).toContain(
      "Sales",
    );
    expect(
      first.model.fact.degenerateDimensions.map((column) => column.name),
    ).toContain("Order ID");
    closeDatabase();
    expect(await saved(project.id)).toEqual(first);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM models WHERE project_id = ?")
        .get(project.id)?.count,
    ).toBe(1);
  });

  it("persists edits and incomplete drafts with validation issues", async () => {
    const { project } = await create();
    const first = await saved(project.id);
    first.model.fact.name = "fact_revenue";
    first.model.fact.grain = "";
    first.model.fact.measures[0].aggregation = "MAX";
    first.model.columnNames["4"] = "Revenue";
    first.model.dimensions.push({
      id: "custom-review",
      name: "dim_review",
      businessKey: "",
      columnIds: [],
      attributes: [],
      generated: null,
      reason: "User-added dimension.",
    });
    const response = await PUT(
      put({ model: first.model }),
      context(project.id),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const edited = (await response.json()) as SavedModel;
    expect(edited.source).toBe("edited");
    expect(edited.validation.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-grain", "missing-business-key"]),
    );
    closeDatabase();
    expect((await saved(project.id)).model).toEqual(first.model);
    const readonly = await createModelSuggestion(project.id);
    expect(readonly.fact.name).toBe("fact_sales");
    expect((await saved(project.id)).model.fact.name).toBe("fact_revenue");
  });

  it("regenerates only on request and uses current profile type overrides", async () => {
    const { project } = await create();
    const first = await saved(project.id);
    first.model.fact.name = "fact_edited";
    expect(
      (await PUT(put({ model: first.model }), context(project.id))).status,
    ).toBe(200);
    updateColumnOverrides(project.id, [{ ordinal: 4, type: "text" }]);
    expect((await saved(project.id)).model.fact.name).toBe("fact_edited");
    const response = await suggest(
      new Request("http://localhost", { method: "POST" }),
      context(project.id),
    );
    expect(response.status).toBe(200);
    const regenerated = (await response.json()) as SavedModel;
    expect(regenerated.source).toBe("suggested");
    expect(regenerated.model.fact.name).toBe("fact_sales");
    expect(
      regenerated.model.fact.measures.some(
        (measure) => measure.columnId === "4",
      ),
    ).toBe(false);
  });

  it("does not overwrite a model when first requests race", async () => {
    const { project } = await create();
    const [first, second] = await Promise.all([
      saved(project.id),
      saved(project.id),
    ]);
    expect(first).toEqual(second);
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM models WHERE project_id = ?")
        .get(project.id)?.count,
    ).toBe(1);
  });

  it("rejects invalid model structures and references without altering the saved model", async () => {
    const { project } = await create();
    const first = await saved(project.id);
    const unknown = structuredClone(first.model);
    unknown.unassigned.push("999");
    const reserved = structuredClone(first.model);
    reserved.dimensions.push({
      id: "fact",
      name: "dim_invalid",
      businessKey: "",
      columnIds: [],
      attributes: [],
      generated: null,
      reason: "Invalid editor location.",
    });
    const foreignKey = structuredClone(first.model);
    foreignKey.fact.foreignKeys.push({
      name: "MissingKey",
      dimensionId: "missing",
      sourceColumnId: null,
      reason: "Invalid reference.",
    });
    const badAggregation = structuredClone(first.model);
    Object.assign(badAggregation.fact.measures[0], { aggregation: "MEDIAN" });
    const missingAliases = structuredClone(first.model);
    missingAliases.columnNames = {};
    const wrongSource = structuredClone(first.model);
    wrongSource.fact.foreignKeys[0].sourceColumnId = "0";
    for (const model of [
      unknown,
      reserved,
      foreignKey,
      badAggregation,
      missingAliases,
      wrongSource,
    ]) {
      const response = await PUT(put({ model }), context(project.id));
      expect(response.status).toBe(400);
    }
    expect(await saved(project.id)).toEqual(first);
  });

  it("validates IDs, JSON, request size, and content type", async () => {
    const { project } = await create();
    expect((await GET(request(), context("invalid"))).status).toBe(400);
    expect((await GET(request(), context(randomUUID()))).status).toBe(404);
    expect(
      (
        await PUT(
          new Request("http://localhost", { method: "PUT", body: "x" }),
          context(project.id),
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await PUT(
          new Request("http://localhost", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: "{",
          }),
          context(project.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PUT(
          new Request("http://localhost", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(16 * 1024 * 1024 + 1),
            },
            body: "{}",
          }),
          context(project.id),
        )
      ).status,
    ).toBe(413);
    expect(readSavedModel(project.id)).toBeUndefined();
  });

  it("validates saved JSON on read and allows explicit recovery by regeneration", async () => {
    const { project } = await create();
    await saved(project.id);
    getDatabase()
      .prepare("UPDATE models SET json = ? WHERE project_id = ?")
      .run('{"fact":"corrupt"}', project.id);
    const response = await GET(request(), context(project.id));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("saved model is invalid");
    expect(await getProject(project.id)).toMatchObject({ id: project.id });
    expect((await getProjects()).map((item) => item.id)).toContain(project.id);
    expect(
      (
        await suggest(
          new Request("http://localhost", { method: "POST" }),
          context(project.id),
        )
      ).status,
    ).toBe(200);
    expect((await saved(project.id)).model.fact.name).toBe("fact_sales");
  });

  it("stores duplicate/null statistics and backfills earlier imports without replacing edits", async () => {
    const { project } = await create("ID,Value\n1,\n1,\n2,x\n");
    expect(project).toMatchObject({ duplicateRowCount: 1, totalNullCells: 2 });
    updateColumnOverrides(project.id, [{ ordinal: 0, type: "text" }]);
    const edited = await saved(project.id);
    edited.model.fact.name = "fact_keep_me";
    edited.model.removeExactDuplicates = true;
    await PUT(put({ model: edited.model }), context(project.id));
    const timestamp = findProject(project.id)!.updatedAt;
    const database = getDatabase();
    database
      .prepare(
        "UPDATE projects SET duplicate_row_count = NULL, total_null_cells = NULL WHERE id = ?",
      )
      .run(project.id);
    database
      .prepare(
        "UPDATE column_profiles SET null_count = NULL, is_near_key_candidate = 0 WHERE project_id = ?",
      )
      .run(project.id);
    const reportPath = join(
      directory,
      "uploads",
      project.id,
      "profile-report.json",
    );
    const report = readProfileReport(project.id);
    writeFileSync(
      reportPath,
      JSON.stringify({
        delimiter: report.delimiter,
        raggedRowCount: report.raggedRowCount,
        raggedRowExamples: report.raggedRowExamples,
      }),
    );
    closeDatabase();
    const refreshed = await ensureProjectEvidence(project.id);
    expect(refreshed).toMatchObject({
      duplicateRowCount: 1,
      totalNullCells: 2,
      updatedAt: timestamp,
    });
    expect(readColumnProfiles(project.id)[0].overrideType).toBe("text");
    expect(readColumnProfiles(project.id)[1].nullCount).toBe(2);
    expect(readProfileReport(project.id)).toMatchObject({
      evidenceVersion: 2,
      sampledRows: [
        ["1", null],
        ["1", null],
        ["2", "x"],
      ],
    });
    expect((await saved(project.id)).model.fact.name).toBe("fact_keep_me");
    expect((await saved(project.id)).model.removeExactDuplicates).toBe(true);
    expect(JSON.parse(readFileSync(reportPath, "utf8")).evidenceVersion).toBe(
      2,
    );
  });

  it("confines legacy source paths before attempting a backfill", async () => {
    const { project } = await create();
    getDatabase()
      .prepare(
        "UPDATE projects SET source_file = ?, duplicate_row_count = NULL WHERE id = ?",
      )
      .run("../../outside.csv", project.id);
    await expect(ensureProjectEvidence(project.id)).rejects.toThrow(
      "source file path is invalid",
    );
    expect((await GET(request(), context(project.id))).status).toBe(422);
    expect(readSavedModel(project.id)).toBeUndefined();
  });
});
