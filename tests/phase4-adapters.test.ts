import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST as upload } from "@/app/api/projects/route";
import { getActivity, getProject, getRuns } from "@/lib/data";
import { validateModel } from "@/lib/modeling/validate";
import { getGeneration } from "@/lib/server/generation";
import { getOrCreateModel, saveEditedModel } from "@/lib/server/models";
import { closeDatabase } from "@/lib/server/db";
import { createQueuedRun, transitionRun, updateRun } from "@/lib/server/runs";
import type { CreateProjectResponse } from "@/lib/server/uploads";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-adapters-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
async function createProject() {
  const form = new FormData();
  form.set("name", "Duplicate sales");
  form.set(
    "file",
    new File(
      [
        "Order ID,Region,Sales\nO-1,East,10\nO-2,West,20\nO-1,East,10\nO-2,West,20\nO-1,East,10\n",
      ],
      "sales.csv",
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
  return ((await response.json()) as CreateProjectResponse).project;
}

describe("real run adapters and duplicate-removal notices", () => {
  it("turns duplicate warnings into info only while the shared removal option is enabled", async () => {
    const project = await createProject();
    const saved = await getOrCreateModel(project.id);
    const columns = Object.entries(saved.model.columnNames).map(
      ([id, name]) => ({ id, name }),
    );
    expect(validateModel(saved.model, columns)).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("3 fully duplicated"),
      }),
    );
    saved.model.removeExactDuplicates = true;
    const notices = validateModel(saved.model, columns);
    expect(notices).toContainEqual({
      code: "duplicates-removed",
      severity: "info",
      message: "3 duplicate rows will be removed during the load.",
    });
    expect(
      notices.some(
        (issue) =>
          issue.severity === "warning" && /duplicat/i.test(issue.message),
      ),
    ).toBe(false);
    saveEditedModel(project.id, saved.model);
    const generation = await getGeneration(project.id);
    expect(generation.validation).toContainEqual(
      expect.objectContaining({ severity: "info", code: "duplicates-removed" }),
    );
    const withoutRemoval = await getGeneration(project.id, { dedupe: false });
    expect(withoutRemoval.validation).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("3 fully duplicated"),
      }),
    );
    expect(
      withoutRemoval.validation.some(
        (issue) => issue.code === "duplicates-removed",
      ),
    ).toBe(false);
  });
  it("starts with an empty history and marks the pipeline complete only after a real successful record", async () => {
    const project = await createProject();
    expect(await getRuns(project.id)).toEqual([]);
    expect((await getProject(project.id))?.stage).toBe(2);
    const run = createQueuedRun(
      project.id,
      { incremental: false, dedupe: true, db: "DataForge" },
      ["00_setup.sql", "04_fact.sql"],
    );
    expect((await getProject(project.id))?.stage).toBe(4);
    transitionRun(run.id, "running");
    transitionRun(run.id, "succeeded", {
      rowsStaged: 5,
      rowsLoaded: 2,
      rowsRejected: 0,
    });
    expect((await getProject(project.id))?.stage).toBe(5);
    expect((await getProject(project.id))?.lastRun).toMatch(/^Succeeded/);
    expect(
      (await getActivity(project.id)).find(
        (activity) => activity.id === run.id,
      ),
    ).toMatchObject({
      kind: "run",
      title: "SQL load succeeded",
      description: expect.stringContaining("2 rows loaded"),
    });
  });
  it("keeps distinct activity IDs for multiple real runs and reflects the latest failure", async () => {
    const project = await createProject();
    const first = createQueuedRun(
      project.id,
      { incremental: false, dedupe: true, db: "DataForge" },
      ["00_setup.sql"],
    );
    updateRun(first.id, { startedAt: "2026-01-01T12:00:00.000Z" });
    transitionRun(first.id, "running");
    transitionRun(first.id, "succeeded", {
      finishedAt: "2026-01-01T12:00:10.000Z",
      rowsLoaded: 2,
    });
    const second = createQueuedRun(
      project.id,
      { incremental: true, dedupe: true, db: "DataForge" },
      ["00_setup.sql"],
    );
    updateRun(second.id, { startedAt: "2026-01-02T12:00:00.000Z" });
    transitionRun(second.id, "running");
    transitionRun(second.id, "failed", {
      finishedAt: "2026-01-02T12:00:10.000Z",
      errorFile: "00_setup.sql",
      errorMessage: "Example SQL failure",
    });
    expect((await getProject(project.id))?.lastRun).toMatch(/^Failed/);
    expect((await getProject(project.id))?.stage).toBe(5);
    const events = (await getActivity(project.id)).filter(
      (activity) => activity.kind === "run",
    );
    expect(events.map((activity) => activity.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect((await getRuns(project.id)).map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);
  });
});
