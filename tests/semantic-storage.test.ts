import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { POST as upload } from "@/app/api/projects/route";
import { GET, PUT } from "@/app/api/projects/[id]/semantic/route";
import { POST as regenerate } from "@/app/api/projects/[id]/semantic/regenerate/route";
import { POST as validate } from "@/app/api/projects/[id]/semantic/measures/validate/route";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { saveConnection } from "@/lib/server/connection";
import { createQueuedRun, transitionRun } from "@/lib/server/runs";
import { compile } from "@/lib/semantic/expr";
import type { SemanticModel } from "@/lib/semantic/types";
import { semanticCache } from "@/lib/semantic/query/cache";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-semantic-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", randomBytes(32).toString("base64"));
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = () => new Request("http://localhost/api/projects/id/semantic");
const json = (value: unknown, method = "POST") =>
  new Request("http://localhost/api/projects/id/semantic", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
function configure(database = "DataForge") {
  saveConnection({
    server: "localhost",
    port: 1433,
    database,
    user: "semantic_test",
    password: "never-return-this-password",
    stagingFolder: "/tmp/staging",
    encrypt: true,
    trustServerCertificate: true,
  });
}
function successful(id: string, database = "DataForge") {
  const run = createQueuedRun(
    id,
    { incremental: false, dedupe: true, db: database },
    [],
  );
  transitionRun(run.id, "running");
  transitionRun(run.id, "succeeded", { rowsLoaded: 2000 });
}
async function create(ready = true) {
  const form = new FormData();
  form.set("name", "Semantic Superstore");
  form.set(
    "file",
    new File(
      [readFileSync(join(process.cwd(), "samples/superstore_sales.csv"))],
      "superstore_sales.csv",
      { type: "text/csv" },
    ),
  );
  const response = await upload(
    new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status).toBe(201);
  const { project } = (await response.json()) as { project: { id: string } };
  if (ready) {
    configure();
    successful(project.id);
  }
  return project.id;
}
async function model(id: string): Promise<SemanticModel> {
  const response = await GET(request(), context(id));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<SemanticModel>;
}
const edit = (model: SemanticModel) => ({
  measures: model.measures,
  hierarchies: model.hierarchies,
  version: model.version,
});

describe("semantic readiness and persistence", () => {
  it("additively upgrades existing hierarchy definitions without deleting them", () => {
    const old = new DatabaseSync(join(directory, "dataforge.db"));
    old.exec(
      'CREATE TABLE semantic_hierarchies (id TEXT, project_id TEXT, name TEXT, "table" TEXT, levels TEXT, PRIMARY KEY (project_id,id))',
    );
    old
      .prepare(
        'INSERT INTO semantic_hierarchies (id,project_id,name,"table",levels) VALUES (?,?,?,?,?)',
      )
      .run(
        "existing",
        "retained-project",
        "Existing hierarchy",
        "dim_product",
        '["category","product"]',
      );
    old.close();
    const row = getDatabase()
      .prepare(
        "SELECT name, levels, is_auto FROM semantic_hierarchies WHERE id = ?",
      )
      .get("existing");
    expect(row?.name).toBe("Existing hierarchy");
    expect(row?.levels).toBe('["category","product"]');
    expect(row?.is_auto).toBe(0);
  });

  it("requires both a configured connection and a successful load in its database", async () => {
    const id = await create(false);
    let response = await GET(request(), context(id));
    expect(response.status).toBe(409);
    configure();
    response = await GET(request(), context(id));
    expect(response.status).toBe(409);
    expect(await response.text()).toMatch(/successful load/i);
    successful(id, "AnotherDatabase");
    expect((await GET(request(), context(id))).status).toBe(409);
    successful(id);
    expect((await GET(request(), context(id))).status).toBe(200);
  });

  it("initializes defaults once, validates persisted JSON, and reads the same version after reopen", async () => {
    const id = await create();
    const first = await model(id);
    expect(first.measures.map((measure) => measure.name)).toEqual(
      expect.arrayContaining([
        "Sales",
        "Sales YTD",
        "Sales LY",
        "Sales YoY %",
        "Row Count",
        "Distinct Order ID",
      ]),
    );
    for (const measure of first.measures)
      expect(() => compile(measure.expression, first)).not.toThrow();
    closeDatabase();
    expect(await model(id)).toEqual(first);
    const publicJson = JSON.stringify(first);
    expect(publicJson).not.toContain("never-return-this-password");
    expect(publicJson).not.toContain("passwordEncrypted");
    getDatabase()
      .prepare(
        "UPDATE semantic_hierarchies SET levels = ? WHERE project_id = ?",
      )
      .run("{bad-json", id);
    const corrupted = await GET(request(), context(id));
    expect(corrupted.status).toBe(500);
    expect(await corrupted.text()).toMatch(/not been replaced/i);
    expect(
      getDatabase()
        .prepare(
          "SELECT levels FROM semantic_hierarchies WHERE project_id = ? LIMIT 1",
        )
        .get(id)?.levels,
    ).toBe("{bad-json");
  });

  it("persists edited auto measures as custom and regenerates dependent names without deleting user definitions", async () => {
    const id = await create();
    const initial = await model(id);
    const sales = initial.measures.find((measure) => measure.name === "Sales")!;
    sales.name = "Revenue ]' --";
    sales.description = "User-edited auto measure";
    // A caller cannot accidentally leave a changed definition marked automatic.
    expect(sales.isAuto).toBe(true);
    const savedResponse = await PUT(json(edit(initial), "PUT"), context(id));
    expect(savedResponse.status, await savedResponse.clone().text()).toBe(200);
    const saved = (await savedResponse.json()) as SemanticModel;
    expect(
      saved.measures.find((measure) => measure.id === sales.id)?.isAuto,
    ).toBe(false);
    expect(
      saved.measures.find((measure) => measure.name === "Sales YTD")
        ?.expression,
    ).toContain("[Revenue ]]' --]");
    const response = await regenerate(
      new Request("http://localhost/semantic/regenerate", { method: "POST" }),
      context(id),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const regenerated = (await response.json()) as SemanticModel;
    const protectedMeasure = regenerated.measures.find(
      (measure) => measure.id === sales.id,
    )!;
    expect(protectedMeasure.name).toBe(sales.name);
    expect(protectedMeasure.expression).toBe(sales.expression);
    for (const measure of regenerated.measures)
      expect(() => compile(measure.expression, regenerated)).not.toThrow();
    expect(
      regenerated.measures.find((measure) => measure.name === "Sales YTD")
        ?.expression,
    ).toContain("[Revenue ]]' --]");
  });

  it("saves custom measures and hierarchies with version checks and never silently restores deletions", async () => {
    const id = await create();
    const first = await model(id);
    const timestamp = new Date().toISOString();
    first.hierarchies[0].name = "Reporting calendar";
    first.measures.push({
      id: randomUUID(),
      name: "Total Sales",
      expression: "[Sales]",
      format: "currency",
      folder: "Custom",
      description: "Saved expression",
      isAuto: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    semanticCache.set(
      "before-edit",
      {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        elapsedMs: 0,
        fromCache: false,
        sql: "SELECT 1",
      },
      id,
    );
    const response = await PUT(json(edit(first), "PUT"), context(id));
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as SemanticModel;
    expect(semanticCache.get("before-edit")).toBeUndefined();
    expect(
      saved.hierarchies.find(
        (hierarchy) => hierarchy.name === "Reporting calendar",
      )?.isAuto,
    ).toBe(false);
    expect(saved.version).not.toBe(first.version);
    expect((await PUT(json(edit(first), "PUT"), context(id))).status).toBe(409);
    const regeneratedResponse = await regenerate(
      new Request("http://localhost/regenerate", { method: "POST" }),
      context(id),
    );
    const regenerated = (await regeneratedResponse.json()) as SemanticModel;
    expect(
      regenerated.hierarchies.some(
        (hierarchy) => hierarchy.name === "Reporting calendar",
      ),
    ).toBe(true);
    expect(
      regenerated.measures.find((measure) => measure.name === "Total Sales")
        ?.folder,
    ).toBe("Custom");
    const empty = {
      measures: [],
      hierarchies: [],
      version: regenerated.version,
    };
    expect((await PUT(json(empty, "PUT"), context(id))).status).toBe(200);
    expect((await model(id)).measures).toEqual([]);
    expect((await model(id)).hierarchies).toEqual([]);
  });

  it("rejects unknown references, duplicate names, invalid hierarchy levels, arbitrary SQL fields, and cycles", async () => {
    const id = await create();
    const first = await model(id);
    const attempts = [
      { ...edit(first), sql: "DROP TABLE dw.fact_sales" },
      {
        ...edit(first),
        measures: [
          ...first.measures,
          { ...first.measures[0], id: "duplicate" },
        ],
      },
      {
        ...edit(first),
        measures: [
          { ...first.measures[0], expression: "SUM('fact_sales'[Missing])" },
        ],
      },
      {
        ...edit(first),
        measures: [{ ...first.measures[0], expression: "[Sales]" }],
      },
      {
        ...edit(first),
        hierarchies: [
          { ...first.hierarchies[0], levels: ["unknown", "unknown-again"] },
        ],
      },
    ];
    for (const attempt of attempts)
      expect((await PUT(json(attempt, "PUT"), context(id))).status).toBe(400);
    expect(await model(id)).toEqual(first);
    expect(
      (await regenerate(json({ sql: "SELECT 1" }), context(id))).status,
    ).toBe(400);
  });

  it("validates expressions with safe SQL previews and positional errors", async () => {
    const id = await create();
    let response = await validate(
      json({ expression: "DIVIDE([Sales], [Quantity])" }),
      context(id),
    );
    expect(response.status).toBe(200);
    const good = (await response.json()) as {
      ok: boolean;
      sql: string;
      dependencies: string[];
    };
    expect(good.ok).toBe(true);
    expect(good.sql).toMatch(/^SELECT/);
    expect(good.dependencies.length).toBeGreaterThan(0);
    response = await validate(json({ expression: "[Salse]" }), context(id));
    const bad = (await response.json()) as {
      ok: boolean;
      errors: { message: string; position: number }[];
    };
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].position).toBe(0);
    expect(bad.errors[0].message).toMatch(/did you mean.*Sales/i);
    expect(
      (await validate(json({ expression: "x".repeat(2001) }), context(id)))
        .status,
    ).toBe(400);
  });
});
