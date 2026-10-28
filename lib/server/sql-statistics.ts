import type { QueryTimings } from "@/lib/semantic/query/types";

type SqlTimingKey =
  "sqlCompileMs" | "sqlCompileCpuMs" | "sqlExecuteMs" | "sqlExecuteCpuMs";

/** SQL Server sends STATISTICS TIME as informational messages, sometimes split across events. */
export class SqlStatisticsCollector {
  private pending = "";
  private readonly totals: Partial<Record<SqlTimingKey, number>> = {};

  add(message: string): void {
    this.pending += message;
    const pattern =
      /SQL Server\s+(parse and compile time|Execution Times)\s*:\s*CPU time\s*=\s*(\d+)\s*ms\s*,\s*elapsed time\s*=\s*(\d+)\s*ms\s*\.?/gi;
    let consumed = 0;
    for (const match of this.pending.matchAll(pattern)) {
      consumed = match.index + match[0].length;
      const cpu = Number(match[2]);
      const elapsed = Number(match[3]);
      if (!Number.isSafeInteger(cpu) || !Number.isSafeInteger(elapsed))
        continue;
      const compile = match[1].toLowerCase().startsWith("parse");
      const elapsedKey = compile ? "sqlCompileMs" : "sqlExecuteMs";
      const cpuKey = compile ? "sqlCompileCpuMs" : "sqlExecuteCpuMs";
      this.totals[elapsedKey] = (this.totals[elapsedKey] ?? 0) + elapsed;
      this.totals[cpuKey] = (this.totals[cpuKey] ?? 0) + cpu;
    }
    if (consumed) this.pending = this.pending.slice(consumed);
    // Retain a partial final heading, not arbitrary PRINT output or unlimited driver text.
    if (this.pending.length > 16_384) {
      const lastHeading = this.pending.toLowerCase().lastIndexOf("sql server");
      this.pending =
        lastHeading >= this.pending.length - 2_048
          ? this.pending.slice(lastHeading)
          : "";
    }
  }

  snapshot(): Partial<QueryTimings> {
    return { ...this.totals };
  }
}
