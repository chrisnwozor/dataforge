import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase } from "@/lib/server/db";
import { saveCheckSettings } from "@/lib/server/verification-storage";
import { LOCAL_WORKSPACE_ID } from "@/lib/auth/migrations";
import { projectFixture } from "./helpers/auth";
const start = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/server/verification", () => ({
  maybeRunChecksAfterLoad: start,
}));
import { scheduleChecksAfterSuccessfulLoad } from "@/lib/server/verification-auto";
let directory: string, projectId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-auto-checks-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_AUTH", "off");
  projectId = projectFixture(LOCAL_WORKSPACE_ID);
  start.mockClear();
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("optional successful-load verification hook", () => {
  it("does nothing by default and queues exactly one project/run identity when enabled", async () => {
    scheduleChecksAfterSuccessfulLoad(projectId, "load-id");
    await flush();
    expect(start).not.toHaveBeenCalled();
    saveCheckSettings(projectId, {
      version: 1,
      autoAfterLoad: true,
      absoluteTolerance: 0.01,
      relativeTolerance: 0.000001,
    });
    scheduleChecksAfterSuccessfulLoad(projectId, "load-id");
    await flush();
    await flush();
    expect(start).toHaveBeenCalledExactlyOnceWith(projectId, "load-id");
  });
  it("does not throw into an already-committed load on a stale project", () => {
    expect(() =>
      scheduleChecksAfterSuccessfulLoad(
        "00000000-0000-4000-8000-999999999999",
        "gone",
      ),
    ).not.toThrow();
  });
});
