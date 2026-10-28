import { describe, expect, it } from "vitest";
import { SqlStatisticsCollector } from "@/lib/server/sql-statistics";

describe("SQL Server STATISTICS TIME info collection", () => {
  it("reads the reported SQL compile and execution elapsed/CPU values", () => {
    const collector = new SqlStatisticsCollector();
    collector.add(
      "SQL Server parse and compile time:\r\n CPU time = 31 ms, elapsed time = 978 ms.",
    );
    collector.add(
      "SQL Server Execution Times:\r\n CPU time = 0 ms, elapsed time = 39 ms.",
    );
    expect(collector.snapshot()).toEqual({
      sqlCompileMs: 978,
      sqlCompileCpuMs: 31,
      sqlExecuteMs: 39,
      sqlExecuteCpuMs: 0,
    });
  });
  it("handles split messages, mixed case, whitespace and multiple statements without double counting", () => {
    const collector = new SqlStatisticsCollector();
    collector.add("SQL Server parse and compile time:");
    collector.add("CPU time = 2 ms, elapsed time = 10 ms.");
    collector.add(
      "sql server execution times: CPU time = 3 ms, elapsed time = 5 ms.\nSQL Server Execution Times: CPU time = 7 ms, elapsed time = 9 ms.",
    );
    collector.add(
      "SQL Server parse and compile time: CPU time = 0 ms, elapsed time = 1 ms.",
    );
    expect(collector.snapshot()).toEqual({
      sqlCompileMs: 11,
      sqlCompileCpuMs: 2,
      sqlExecuteMs: 14,
      sqlExecuteCpuMs: 10,
    });
  });
  it("retains statistics text when event boundaries fall inside headings or numeric values", () => {
    const collector = new SqlStatisticsCollector();
    const text =
      "SQL Server parse and compile time:\r\nCPU time = 31 ms, elapsed time = 978 ms.\r\nSQL Server Execution Times:\r\nCPU time = 2 ms, elapsed time = 39 ms.";
    for (const fragment of text.match(/[\s\S]{1,9}/g)!) collector.add(fragment);
    expect(collector.snapshot()).toEqual({
      sqlCompileMs: 978,
      sqlCompileCpuMs: 31,
      sqlExecuteMs: 39,
      sqlExecuteCpuMs: 2,
    });
  });
  it("leaves unavailable measurements absent instead of reporting a false zero", () => {
    const collector = new SqlStatisticsCollector();
    collector.add("(2000 rows affected)");
    collector.add("A login completed; CPU time = 1 ms, elapsed time = 5 ms.");
    expect(collector.snapshot()).toEqual({});
    collector.add(
      "SQL Server Execution Times: CPU time = 0 ms, elapsed time = 0 ms.",
    );
    expect(collector.snapshot()).toEqual({
      sqlExecuteMs: 0,
      sqlExecuteCpuMs: 0,
    });
  });
  it("bounds unrelated info output while retaining a final partial statistics heading", () => {
    const collector = new SqlStatisticsCollector();
    collector.add("x".repeat(100_000));
    collector.add(`${"y".repeat(20_000)}SQL Server Execution Times:`);
    collector.add("CPU time = 4 ms, elapsed time = 6 ms.");
    expect(collector.snapshot()).toEqual({
      sqlExecuteMs: 6,
      sqlExecuteCpuMs: 4,
    });
    const snapshot = collector.snapshot();
    snapshot.sqlExecuteMs = 1_000;
    expect(collector.snapshot().sqlExecuteMs).toBe(6);
  });
});
