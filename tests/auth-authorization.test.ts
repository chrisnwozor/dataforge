import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import { createEmptyDashboard } from "@/lib/dashboards/schema";
import { createEmptyReport } from "@/lib/reports/schema";
import { createEmptyView } from "@/lib/explore/config";
import {
  createDashboard,
  getDashboard,
  listDashboards,
} from "@/lib/server/dashboards";
import {
  createReport,
  createReportRun,
  getReport,
  getReportRun,
  listReports,
} from "@/lib/server/reports";
import {
  createExploreView,
  getExploreView,
  listExploreViews,
} from "@/lib/server/explore-views";
import {
  createQueuedRun,
  getRun,
  getRunDetail,
  listRuns,
} from "@/lib/server/runs";
import {
  findProject,
  listProjects,
  projectUploadDirectory,
  readColumnProfiles,
} from "@/lib/server/projects";
import { openReportExport, writeReportExport } from "@/lib/server/report-files";
import { safeSourceFile } from "@/lib/server/sources";
import { requireProjectAccess, currentWorkspaceId } from "@/lib/auth/context";
import { withWorkspaceRoute } from "@/lib/auth/guards";
import { createSession } from "@/lib/auth/sessions";
import {
  asUser,
  authRequest,
  memberFixture,
  projectFixture,
  userFixture,
  workspaceFixture,
} from "./helpers/auth";

const projectRoutes = import.meta.glob<{ [name: string]: unknown }>(
  "../app/api/projects/[[]id[]]/**/route.ts",
);
let directory: string,
  alice: string,
  bob: string,
  alpha: string,
  beta: string,
  a: string,
  b: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "df-auth-isolation-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "on");
  vi.stubEnv("DATAFORGE_APP_URL", "http://localhost");
  alice = userFixture("alice@example.test");
  bob = userFixture("bob@example.test");
  alpha = workspaceFixture(alice, "Alpha");
  beta = workspaceFixture(bob, "Beta");
  a = projectFixture(alpha);
  b = projectFixture(beta);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const notFound = (callback: () => unknown) => {
  try {
    callback();
    throw new Error("Expected denial");
  } catch (error) {
    expect(error).toMatchObject({ status: 404 });
  }
};
describe("tenant-aware data access", () => {
  it("isolates project lists and denies foreign projects, profiles and file roots", () => {
    asUser(alice, alpha, () => {
      expect(listProjects().map((p) => p.id)).toEqual([a]);
      expect(findProject(a)?.id).toBe(a);
      for (const load of [
        () => findProject(b),
        () => readColumnProfiles(b),
        () => projectUploadDirectory(b),
      ])
        notFound(load);
      expect(projectUploadDirectory(a)).toContain(
        join("workspaces", alpha, "uploads", a),
      );
      for (const id of [
        "../other",
        "..\\other",
        "%2e%2e",
        "/tmp/file",
        `${a}/../${b}`,
      ])
        expect(() => projectUploadDirectory(id)).toThrow();
    });
  });
  it("isolates run IDs and logs even when the caller knows a foreign run UUID", () => {
    const run = asUser(bob, beta, () =>
      createQueuedRun(
        b,
        { db: "Warehouse", incremental: false, dedupe: false },
        ["00_setup.sql"],
      ),
    );
    asUser(alice, alpha, () => {
      notFound(() => getRun(run.id));
      notFound(() => getRunDetail(run.id));
      notFound(() => listRuns(b));
      expect(listRuns(a)).toEqual([]);
    });
  });
  it("isolates dashboards, reports, views, report runs and exports", () => {
    const foreign = asUser(bob, beta, () => {
      const dashboard = createDashboard(
          b,
          createEmptyDashboard("Beta dashboard"),
        ),
        report = createReport(b, createEmptyReport("Beta report")),
        view = createExploreView(b, {
          name: "Beta view",
          config: createEmptyView(),
        }),
        run = createReportRun(b, report.id);
      writeReportExport(report.id, run.id, "csv", Buffer.from("private\n"));
      return { dashboard, report, view, run };
    });
    asUser(alice, alpha, () => {
      for (const load of [
        () => getDashboard(b, foreign.dashboard.id),
        () => getDashboard(a, foreign.dashboard.id),
        () => listDashboards(b),
        () => getReport(b, foreign.report.id),
        () => getReport(a, foreign.report.id),
        () => listReports(b),
        () => getExploreView(b, foreign.view.id),
        () => getExploreView(a, foreign.view.id),
        () => listExploreViews(b),
        () => getReportRun(b, foreign.report.id, foreign.run.id),
        () => openReportExport(foreign.report.id, foreign.run.id, "csv"),
      ])
        notFound(load);
    });
    expect(
      getDatabase()
        .prepare("SELECT workspace_id FROM report_runs WHERE id=?")
        .get(foreign.run.id)?.workspace_id,
    ).toBe(beta);
    expect(
      getDatabase()
        .prepare("SELECT workspace_id FROM dashboards WHERE id=?")
        .get(foreign.dashboard.id)?.workspace_id,
    ).toBe(beta);
  });
  it("refuses forged workspace IDs on child writes and moving a project to another tenant", () => {
    const id = randomUUID(),
      now = new Date().toISOString();
    expect(() =>
      getDatabase()
        .prepare(
          "INSERT INTO explore_views(id,project_id,workspace_id,name,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          b,
          alpha,
          "Forged",
          JSON.stringify(createEmptyView()),
          now,
          now,
        ),
    ).toThrow(/Tenant mismatch/);
    expect(() =>
      getDatabase()
        .prepare("UPDATE projects SET workspace_id=? WHERE id=?")
        .run(alpha, b),
    ).toThrow(/cannot change/);
  });
  it("rejects a cross-project stored source path and symlink parents", async () => {
    const sourceId = randomUUID(),
      path = asUser(bob, beta, () => projectUploadDirectory(b));
    mkdirSync(join(path, "sources", sourceId), { recursive: true });
    const file = join(path, "sources", sourceId, "private.csv");
    writeFileSync(file, "id\n1\n");
    const forged = {
      id: sourceId,
      projectId: a,
      name: "forged",
      kind: "csv" as const,
      filePath: file,
      options: {
        version: 1 as const,
        headerRow: 1,
        jsonArrayPath: "",
        arraySeparator: " | ",
      },
      rowCount: 1,
      columns: [{ name: "id", type: "integer" as const }],
      createdAt: new Date().toISOString(),
    };
    const own = asUser(alice, alpha, () => projectUploadDirectory(a));
    mkdirSync(join(own, "sources"), { recursive: true });
    symlinkSync(
      join(path, "sources", sourceId),
      join(own, "sources", sourceId),
      "dir",
    );
    await expect(
      asUser(alice, alpha, () => safeSourceFile(forged)),
    ).rejects.toThrow(/regular|unavailable/);
    await expect(
      asUser(alice, alpha, () => safeSourceFile({ ...forged, projectId: b })),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("returns 403 only for insufficient roles inside a member workspace, and 404 for foreign IDs", () => {
    memberFixture(alpha, bob, "viewer");
    asUser(bob, alpha, () => {
      expect(requireProjectAccess(a, "viewer").role).toBe("viewer");
      expect(() => requireProjectAccess(a, "editor")).toThrow(/role/);
      expect(currentWorkspaceId()).toBe(alpha);
    });
    asUser(alice, alpha, () =>
      notFound(() => requireProjectAccess(b, "owner")),
    );
  });
  it("blocks connection APIs for every non-admin role and cross-origin mutation", async () => {
    const viewer = userFixture();
    memberFixture(alpha, viewer, "viewer");
    const { GET, PUT } = await import("@/app/api/settings/connection/route");
    expect(
      (
        await Reflect.apply(GET, undefined, [
          authRequest(viewer, "/api/settings/connection"),
        ])
      ).status,
    ).toBe(403);
    expect(
      (await PUT(authRequest(viewer, "/api/settings/connection", "PUT", {})))
        .status,
    ).toBe(403);
    const endpoint = withWorkspaceRoute("viewer", async (request: Request) =>
      Response.json({ ok: request.method === "GET" }),
    );
    const session = createSession(alice);
    expect(
      (
        await endpoint(
          new Request("http://localhost/api", {
            method: "POST",
            headers: {
              cookie: `dataforge_session=${session.token}`,
              origin: "https://evil.example",
            },
          }),
        )
      ).status,
    ).toBe(403);
  });
});
describe("every project HTTP endpoint", () => {
  it("discovers a non-empty inventory and returns 404 for every method with a foreign project ID", async () => {
    expect(Object.keys(projectRoutes).length).toBeGreaterThan(40);
    const session = createSession(alice);
    let checked = 0;
    for (const [file, load] of Object.entries(projectRoutes)) {
      const endpoints = await load();
      for (const [method, handler] of Object.entries(endpoints)) {
        if (
          !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method) ||
          typeof handler !== "function"
        )
          continue;
        const path = file
          .replace("../app", "")
          .replace("/route.ts", "")
          .replaceAll("[id]", b)
          .replace(/\[[^\]]+\]/g, randomUUID());
        const request = new Request(`http://localhost${path}`, {
          method,
          headers: {
            cookie: `dataforge_session=${session.token}`,
            origin: "http://localhost",
            "Content-Type": "application/json",
          },
          ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
        });
        const response = await handler(request, {
          params: Promise.resolve({
            id: b,
            runId: randomUUID(),
            sourceId: randomUUID(),
            dashboardId: randomUUID(),
            reportId: randomUUID(),
            viewId: randomUUID(),
            scheduleId: randomUUID(),
          }),
        });
        expect(response.status, `${method} ${file}`).toBe(404);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(65);
  });
  it("does not let a missing or forged session reach a protected handler", async () => {
    const endpoint = withWorkspaceRoute(
      "viewer",
      vi.fn(async (request: Request) =>
        Response.json({ private: request.method === "GET" }),
      ),
    );
    expect((await endpoint(new Request("http://localhost/api"))).status).toBe(
      401,
    );
    expect(
      (
        await endpoint(
          new Request("http://localhost/api", {
            headers: {
              cookie: "dataforge_session=forged",
              "x-dataforge-user": alice,
              "x-workspace-id": alpha,
            },
          }),
        )
      ).status,
    ).toBe(401);
  });
});

describe("live stream revocation", () => {
  for (const change of ["session", "role"] as const)
    it(`closes a live Runs stream after ${change} revocation`, async () => {
      vi.useFakeTimers();
      try {
        const editor = userFixture();
        memberFixture(alpha, editor, "editor");
        const run = asUser(editor, alpha, () =>
          createQueuedRun(
            a,
            { db: "Warehouse", incremental: false, dedupe: false },
            ["00_setup.sql"],
          ),
        );
        const session = createSession(editor);
        const { GET } =
          await import("@/app/api/projects/[id]/runs/[runId]/events/route");
        const response = await GET(
          new Request(
            `http://localhost/api/projects/${a}/runs/${run.id}/events`,
            { headers: { cookie: `dataforge_session=${session.token}` } },
          ),
          { params: Promise.resolve({ id: a, runId: run.id }) },
        );
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        if (change === "session")
          getDatabase()
            .prepare("DELETE FROM sessions WHERE id=?")
            .run(session.id);
        else memberFixture(alpha, editor, "viewer");
        const next = reader.read();
        await vi.advanceTimersByTimeAsync(501);
        expect((await next).done).toBe(true);
        reader.releaseLock();
      } finally {
        vi.useRealTimers();
      }
    });
});
