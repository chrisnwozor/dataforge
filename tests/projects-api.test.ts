import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as XLSX from "xlsx";
import { GET as list, POST as upload } from "@/app/api/projects/route";
import {
  GET as profile,
  PATCH as override,
} from "@/app/api/projects/[id]/profile/route";
import { closeDatabase } from "@/lib/server/db";
import { boundedBody } from "@/lib/server/http";
import { MAX_UPLOAD_BYTES } from "@/lib/server/uploads";
import type { CreateProjectResponse } from "@/lib/server/uploads";
import type { ProjectProfileResponse } from "@/app/api/projects/[id]/profile/route";
import { getProject, getProjects, getColumnProfiles } from "@/lib/data";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-api-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function multipart(
  contents: string | Uint8Array,
  name = "sales.csv",
  type = "text/csv",
  projectName = "Real sales",
) {
  const form = new FormData();
  form.set("name", projectName);
  form.set(
    "file",
    new File(
      [typeof contents === "string" ? contents : Uint8Array.from(contents)],
      name,
      { type },
    ),
  );
  form.set("targetDatabase", "SQL Server 2022");
  return new Request("http://localhost/api/projects", {
    method: "POST",
    body: form,
  });
}
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}
function patch(body: unknown) {
  return new Request("http://localhost/api/projects/id/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function create(
  contents = "ID,Name,Amount\n1,Alice,12.50\n2,,25.75\n3,Alice,30.00\n",
) {
  const response = await upload(multipart(contents));
  expect(response.status).toBe(201);
  return (await response.json()) as CreateProjectResponse;
}
describe("real upload and profile API", () => {
  it("starts without seed projects and persists file, columns, and projects across DB reopen", async () => {
    expect(await (await list()).json()).toEqual({ projects: [] });
    const body = await create();
    const { id } = body.project;
    expect(body.project).toMatchObject({
      name: "Real sales",
      sourceType: "CSV",
      rowCount: 3,
      columnCount: 3,
      status: "Ready",
    });
    expect(
      readFileSync(join(directory, "uploads", id, "sales.csv"), "utf8"),
    ).toContain("Alice");
    expect(existsSync(join(directory, "dataforge.db"))).toBe(true);
    closeDatabase();
    const response = await profile(
      new Request("http://localhost"),
      context(id),
    );
    expect(response.status).toBe(200);
    const saved = (await response.json()) as ProjectProfileResponse;
    expect(saved.columns).toHaveLength(3);
    expect(saved.columns[0]).toMatchObject({
      inferredType: "integer",
      isKeyCandidate: true,
      overrideType: null,
    });
    expect(saved.columns[1]).toMatchObject({
      distinctCount: 1,
      duplicateCount: 1,
      sampleValues: ["Alice"],
    });
    expect(saved.columns[1].nullPct).toBeCloseTo(100 / 3, 2);
    expect((await getProjects()).map((p) => p.id)).toEqual([id]);
    expect(await getProject(id)).toMatchObject({
      rows: 3,
      columns: 3,
      sourceName: "sales.csv",
    });
    expect(await getProject("superstore-sales")).toBeUndefined();
  });
  it("persists and clears type overrides without replacing inferred types", async () => {
    const { project } = await create();
    const response = await override(
      patch({ overrides: [{ ordinal: 0, type: "text" }] }),
      context(project.id),
    );
    expect(response.status).toBe(200);
    closeDatabase();
    expect((await getColumnProfiles(project.id))[0]).toMatchObject({
      type: "VARCHAR",
      inferredType: "INT",
      overrideType: "VARCHAR",
    });
    const reset = await override(
      patch({ overrides: [{ ordinal: 0, type: null }] }),
      context(project.id),
    );
    expect(reset.status).toBe(200);
    expect((await getColumnProfiles(project.id))[0]).toMatchObject({
      type: "INT",
      overrideType: null,
    });
  });
  it("validates overrides and rolls back a batch with an unknown column", async () => {
    const { project } = await create();
    for (const body of [
      { overrides: [{ ordinal: 0, type: "INVALID" }] },
      {
        overrides: [
          { ordinal: 0, type: "text" },
          { ordinal: 0, type: "integer" },
        ],
      },
      {
        overrides: [
          { ordinal: 0, type: "text" },
          { ordinal: 999, type: "decimal" },
        ],
      },
    ]) {
      expect((await override(patch(body), context(project.id))).status).toBe(
        400,
      );
    }
    expect((await getColumnProfiles(project.id))[0].overrideType).toBeNull();
  });
  it("reports ragged rows while persisting an upload", async () => {
    const { project, profile: result } = await create(
      "ID,Name\n1,Alice\n2\n3,Bob,extra\n",
    );
    expect(result.raggedRowCount).toBe(2);
    expect(project.status).toBe("Needs review");
    const saved = (await (
      await profile(new Request("http://localhost"), context(project.id))
    ).json()) as ProjectProfileResponse;
    expect(saved.report).toMatchObject({
      raggedRowCount: 2,
      raggedRowExamples: [
        { row: 3, expected: 2, actual: 1 },
        { row: 4, expected: 2, actual: 3 },
      ],
    });
  });
  it("accepts XLSX and profiles the first worksheet", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["ID", "Sales"],
        [1, 12.5],
        [2, 25.1],
      ]),
      "Sales",
    );
    const bytes = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }) as Buffer;
    const response = await upload(
      multipart(
        bytes,
        "sales.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).project).toMatchObject({
      sourceType: "XLSX",
      rowCount: 2,
      columnCount: 2,
    });
  });
  it("binds SQL input as data and confines source filenames to the project directory", async () => {
    const projectName = "Sales'); DROP TABLE projects; --";
    const response = await upload(
      multipart("ID\n1\n2\n", "..\\..\\outside.csv", "text/csv", projectName),
    );
    expect(response.status).toBe(201);
    const { project } = (await response.json()) as CreateProjectResponse;
    expect(project.sourceFile).toBe("outside.csv");
    expect((await getProjects())[0].name).toBe(projectName);
    expect(
      existsSync(join(directory, "uploads", project.id, "outside.csv")),
    ).toBe(true);
  });
  it("rejects bad files and cleans up parse failures without adding a project", async () => {
    for (const [contents, name, type, status] of [
      ["", "empty.csv", "text/csv", 400],
      ["1,2", "file.exe", "application/octet-stream", 415],
      [
        "abc",
        "bad.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        415,
      ],
      ["\0\0bad", "binary.csv", "text/csv", 415],
      ['ID,Name\n1,"unterminated', "invalid.csv", "text/csv", 422],
    ] as const) {
      const response = await upload(multipart(contents, name, type));
      expect(response.status, `${name}: ${await response.clone().text()}`).toBe(
        status,
      );
    }
    expect(await getProjects()).toEqual([]);
    const uploads = join(directory, "uploads");
    expect(existsSync(uploads) ? readdirSync(uploads) : []).toEqual([]);
  });
  it("validates name and HTTP payload formats", async () => {
    expect(
      (await upload(multipart("ID\n1\n", "file.csv", "text/csv", "   ")))
        .status,
    ).toBe(400);
    expect(
      (
        await upload(
          new Request("http://localhost/api/projects", {
            method: "POST",
            body: "not multipart",
          }),
        )
      ).status,
    ).toBe(415);
    expect(
      (await profile(new Request("http://localhost"), context("invalid")))
        .status,
    ).toBe(400);
    expect(
      (await profile(new Request("http://localhost"), context(randomUUID())))
        .status,
    ).toBe(404);
  });
  it("enforces the file's actual 50 MiB limit without relying on Content-Length", async () => {
    const form = new FormData();
    form.set("name", "Too large");
    form.set(
      "file",
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "oversize.csv", {
        type: "text/csv",
      }),
    );
    const request = new Request("http://localhost/api/projects", {
      method: "POST",
      body: form,
    });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await upload(request);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toContain("50 MB");
    expect(existsSync(join(directory, "uploads"))).toBe(false);
  });
  it("rejects over-limit bodies before storing any data and caps chunked requests", async () => {
    const request = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "content-length": String(MAX_UPLOAD_BYTES + 1024 * 1024),
      },
      body: "x",
    });
    expect((await upload(request)).status).toBe(413);
    const stream = await boundedBody(
      new Request("http://localhost", { method: "POST", body: "12345" }),
      4,
    );
    await expect(new Response(stream).text()).rejects.toThrow("too large");
    expect(existsSync(join(directory, "uploads"))).toBe(false);
  });
});
