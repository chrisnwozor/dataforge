import type { QueryTimings } from "@/lib/semantic/query/types";
import type { SqlParameter } from "@/lib/semantic/types";
import { errorResponse } from "./http";

export interface QueryTimingContext {
  startedAt: number;
  timings: QueryTimings;
  finished: boolean;
  sql?: string;
  params?: SqlParameter[];
}

export function startQueryTiming(): QueryTimingContext {
  return {
    startedAt: performance.now(),
    timings: {
      parseMs: 0,
      compileMs: 0,
      cacheLookupMs: 0,
      poolAcquireMs: 0,
      connectMs: 0,
      sendToFirstRowMs: 0,
      fetchMs: 0,
      totalMs: 0,
    },
    finished: false,
  };
}

export function addQueryPhase(
  context: QueryTimingContext,
  phase: keyof QueryTimings,
  startedAt: number,
): void {
  context.timings[phase] =
    (context.timings[phase] ?? 0) + Math.max(0, performance.now() - startedAt);
}

/** Log only numeric phases and an application project ID, never SQL, values, or credentials. */
export function finishQueryTiming(
  context: QueryTimingContext,
  projectId: string,
  status: "succeeded" | "failed",
  fromCache = false,
): QueryTimings {
  if (!context.finished) {
    context.timings.totalMs = Math.max(
      0,
      performance.now() - context.startedAt,
    );
    for (const phase of Object.keys(
      context.timings,
    ) as (keyof QueryTimings)[]) {
      const value = context.timings[phase];
      if (typeof value === "number" && Number.isFinite(value))
        context.timings[phase] = Math.round(value * 100) / 100;
      else delete context.timings[phase];
    }
    context.finished = true;
    console.info(
      JSON.stringify({
        event: "dataforge.query.timing",
        projectId,
        status,
        fromCache,
        timings: context.timings,
        slowPhases: Object.entries(context.timings)
          .filter(([, value]) => typeof value === "number" && value > 2_000)
          .map(([phase]) => phase),
      }),
    );
  }
  return { ...context.timings };
}

export function recordQueryFailure(
  error: unknown,
  context: QueryTimingContext,
  projectId: string,
): void {
  const timings = finishQueryTiming(context, projectId, "failed");
  if (error instanceof Error) Object.assign(error, { queryTimings: timings });
}

export async function queryErrorResponse(
  error: unknown,
  fallback: string,
  context: QueryTimingContext,
  projectId: string,
): Promise<Response> {
  recordQueryFailure(error, context, projectId);
  const response = errorResponse(error, fallback);
  return Response.json(
    {
      ...(await response.json()),
      timings: { ...context.timings },
      ...(context.sql ? { sql: context.sql } : {}),
      ...(context.params ? { params: context.params } : {}),
    },
    { status: response.status, headers: { "Cache-Control": "no-store" } },
  );
}
