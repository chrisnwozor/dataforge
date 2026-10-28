import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/http";
import {
  addQueryPhase,
  finishQueryTiming,
  queryErrorResponse,
  startQueryTiming,
} from "@/lib/server/query-timing";

afterEach(() => vi.restoreAllMocks());
describe("query timing diagnostics", () => {
  it("accounts for phases, flags only phases above two seconds, and logs once without SQL or values", () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const logger = vi.spyOn(console, "info").mockImplementation(() => {});
    const context = startQueryTiming();
    context.sql = "SELECT @private_value";
    now += 2_000;
    addQueryPhase(context, "connectMs", 100);
    const sendStart = now;
    now += 2_001;
    addQueryPhase(context, "sendToFirstRowMs", sendStart);
    const timings = finishQueryTiming(context, "project", "succeeded");
    expect(timings.totalMs).toBe(4_001);
    expect(timings.connectMs).toBe(2_000);
    expect(timings.sendToFirstRowMs).toBe(2_001);
    finishQueryTiming(context, "project", "succeeded");
    expect(logger).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(logger.mock.calls[0][0]));
    expect(logged.slowPhases).toEqual(["sendToFirstRowMs", "totalMs"]);
    expect(JSON.stringify(logged)).not.toContain("private_value");
    expect(JSON.stringify(logged)).not.toContain("SELECT");
  });

  it("returns timing and generated SQL for failed requests while keeping the HTTP error status", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const context = startQueryTiming();
    context.sql = "SELECT @p0 AS [value];";
    context.timings.sendToFirstRowMs = 30_000;
    const response = await queryErrorResponse(
      new HttpError(504, "The query exceeded its timeout."),
      "fallback",
      context,
      "project",
    );
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "The query exceeded its timeout.",
      sql: context.sql,
      timings: { sendToFirstRowMs: 30_000, connectMs: 0, fetchMs: 0 },
    });
  });
});
