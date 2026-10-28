import { ZodError } from "zod";
import {
  compileQuery,
  compileDistinctValues,
} from "@/lib/semantic/query/compile";
import { normalizeQuery } from "@/lib/semantic/query/schema";
import {
  normalizedJson,
  resultCacheKey,
  semanticCache,
} from "@/lib/semantic/query/cache";
import type {
  AttributeRef,
  CompiledQuery,
  QueryResult,
  QueryValue,
} from "@/lib/semantic/query/types";
import type { SemanticModel } from "@/lib/semantic/types";
import { redactSecrets } from "@/lib/runner/secrets";
import { readPublicConnection, friendlyConnectionError } from "./connection";
import { HttpError } from "./http";
import {
  getSemanticModel,
  readSemanticStamp,
  requireSemanticReady,
} from "./semantic";
import { executeCompiledQuery, QueryAbortedError } from "./query-transport";
import {
  addQueryPhase,
  finishQueryTiming,
  recordQueryFailure,
  startQueryTiming,
  type QueryTimingContext,
} from "./query-timing";

function serializable(value: unknown, date: boolean): QueryValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date)
    return Number.isFinite(value.getTime())
      ? date
        ? value.toISOString().slice(0, 10)
        : value.toISOString()
      : null;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  return String(value);
}

function resultFromRows(
  compiled: CompiledQuery,
  records: Record<string, unknown>[],
  elapsedMs: number,
): QueryResult {
  let truncated = records.length > compiled.limit;
  const source = records.slice(0, compiled.limit);
  const rows = source.map((record) =>
    Object.fromEntries(
      compiled.columns.map((column) => [
        column.key,
        serializable(record[column.key], column.type === "date"),
      ]),
    ),
  );
  let pivot: QueryResult["pivot"];
  if (compiled.pivot) {
    const values = new Map<string, QueryValue[]>();
    for (const row of rows) {
      const tuple = compiled.pivot.columnKeys.map((key) => row[key]);
      values.set(JSON.stringify(tuple), tuple);
    }
    if (values.size > 50)
      throw new HttpError(
        500,
        "The generated pivot exceeded its column limit.",
      );
    if (source.some((record) => Number(record.__df_pivot_total) > 50))
      truncated = true;
    pivot = { ...compiled.pivot, columnValues: [...values.values()] };
  }
  return {
    columns: compiled.columns,
    rows,
    rowCount: rows.length,
    truncated,
    elapsedMs,
    fromCache: false,
    sql: compiled.sql,
    params: compiled.params,
    ...(pivot ? { pivot } : {}),
  };
}

function executionError(
  error: unknown,
  password: string,
  signal?: AbortSignal,
): never {
  if (signal?.aborted || error instanceof QueryAbortedError)
    throw new HttpError(499, "The query was cancelled.");
  if (error instanceof HttpError) throw error;
  const record = error as {
    code?: unknown;
    number?: unknown;
    message?: unknown;
  } | null;
  const code = String(record?.code ?? "");
  if (code === "ETIMEOUT")
    throw new HttpError(
      504,
      "The query exceeded the 30-second timeout. Reduce the selected attributes or filters and try again.",
    );
  if (record?.number === 207 || record?.number === 208)
    throw new HttpError(
      409,
      "The warehouse no longer matches this semantic model. Run a successful load with the current model, then try again.",
    );
  if (/ELOGIN|ESOCKET|ECONN|ENOTFOUND|EHOST|EINSTLOOKUP/.test(code))
    throw new HttpError(400, friendlyConnectionError(error, password));
  const detail = redactSecrets(String(record?.message ?? ""), [
    password,
    process.env.DATAFORGE_SECRET ?? "",
  ]).slice(0, 2000);
  throw new HttpError(
    500,
    detail
      ? `SQL Server could not complete the generated query: ${detail}`
      : "SQL Server could not complete the generated query.",
  );
}

function compilationError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof ZodError)
    throw new HttpError(
      400,
      error.issues[0]?.message ?? "Invalid semantic query.",
    );
  const value = error as { status?: unknown; message?: unknown } | null;
  if (value?.status === 400)
    throw new HttpError(
      400,
      String(value.message ?? "Invalid semantic query."),
    );
  throw error;
}

async function executeCached(
  projectId: string,
  input: unknown | ((model: SemanticModel) => unknown),
  build: (model: SemanticModel) => CompiledQuery,
  signal?: AbortSignal,
  timing: QueryTimingContext = startQueryTiming(),
  diagnostics = false,
): Promise<QueryResult> {
  let password = "";
  try {
    if (signal?.aborted) throw new HttpError(499, "The query was cancelled.");
    const metadataStart = performance.now();
    let ready: ReturnType<typeof requireSemanticReady>;
    let model: SemanticModel;
    let stamp: string;
    try {
      ready = await requireSemanticReady(projectId);
      password = ready.settings.password;
      model = await getSemanticModel(projectId);
      stamp = readSemanticStamp(projectId);
    } finally {
      addQueryPhase(timing, "compileMs", metadataStart);
    }
    const connectionVersion = readPublicConnection().updatedAt ?? "";
    semanticCache.useNamespace(
      projectId,
      normalizedJson([ready.run.id, model.version, connectionVersion]),
    );
    const cacheInput = typeof input === "function" ? input(model) : input;
    const cacheStart = performance.now();
    const key = resultCacheKey(
      projectId,
      ready.run.id,
      model.version,
      cacheInput,
      connectionVersion,
    );
    const cached = diagnostics ? undefined : semanticCache.get(key);
    addQueryPhase(timing, "cacheLookupMs", cacheStart);
    if (cached) {
      timing.sql = cached.sql;
      timing.params = cached.params;
      const timings = finishQueryTiming(timing, projectId, "succeeded", true);
      return {
        ...cached,
        fromCache: true,
        elapsedMs: timings.totalMs,
        timings,
      };
    }
    // Cache hits skip SQL compilation entirely. Metadata validation is still required to gate access.
    const compileStart = performance.now();
    let compiled: CompiledQuery;
    try {
      compiled = build(model);
      if (diagnostics) compiled = { ...compiled, diagnostics: true };
    } catch (error) {
      compilationError(error);
    } finally {
      addQueryPhase(timing, "compileMs", compileStart);
    }
    timing.sql = compiled.sql;
    timing.params = compiled.params;
    const rows = await executeCompiledQuery(
      ready.settings,
      compiled,
      signal,
      (phases) => {
        for (const phase of [
          "poolAcquireMs",
          "connectMs",
          "sendToFirstRowMs",
          "fetchMs",
          "sqlCompileMs",
          "sqlExecuteMs",
          "sqlCompileCpuMs",
          "sqlExecuteCpuMs",
        ] as const)
          if (typeof phases[phase] === "number")
            timing.timings[phase] = Math.max(0, phases[phase]!);
      },
    );
    const result = resultFromRows(compiled, rows, 0);
    // Check cheap revisions instead of deriving/parsing the complete semantic model twice per query.
    const current = await requireSemanticReady(projectId);
    if (
      !diagnostics &&
      current.run.id === ready.run.id &&
      readSemanticStamp(projectId) === stamp &&
      (readPublicConnection().updatedAt ?? "") === connectionVersion
    )
      semanticCache.set(key, result, projectId);
    const timings = finishQueryTiming(timing, projectId, "succeeded");
    return { ...result, elapsedMs: timings.totalMs, timings };
  } catch (error) {
    try {
      executionError(error, password, signal);
    } catch (failure) {
      recordQueryFailure(failure, timing, projectId);
      throw failure;
    }
  }
}

export async function runSemanticQuery(
  projectId: string,
  input: unknown,
  signal?: AbortSignal,
  timing: QueryTimingContext = startQueryTiming(),
): Promise<QueryResult> {
  let normalized;
  const parseStart = performance.now();
  try {
    try {
      normalized = normalizeQuery(input);
    } finally {
      addQueryPhase(timing, "parseMs", parseStart);
    }
  } catch (error) {
    try {
      compilationError(error);
    } catch (failure) {
      recordQueryFailure(failure, timing, projectId);
      throw failure;
    }
  }
  return executeCached(
    projectId,
    { kind: "query", query: normalized },
    (model) => compileQuery(model, normalized),
    signal,
    timing,
    normalized.diagnostics === true,
  );
}

export function resolveValueAttribute(
  model: SemanticModel,
  value: unknown,
): AttributeRef {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      /* A unique column ID is also supported. */
    }
    if (parsed && typeof parsed === "object")
      return resolveValueAttribute(model, parsed);
    const matches = model.tables.flatMap((table) =>
      table.columns
        .filter((column) => column.id === value)
        .map((column) => ({ table: table.id, column: column.id })),
    );
    if (matches.length === 1) return matches[0];
    throw new HttpError(
      400,
      "Choose a known attribute by column ID or a JSON {table,column} reference.",
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    if (
      Object.keys(ref).length === 2 &&
      typeof ref.table === "string" &&
      typeof ref.column === "string"
    )
      return { table: ref.table, column: ref.column };
  }
  throw new HttpError(
    400,
    "Provide an attribute reference as JSON {table,column} or a unique column ID.",
  );
}

export async function getDistinctValues(
  projectId: string,
  attribute: unknown,
  signal?: AbortSignal,
  hideUnknown = true,
  timing: QueryTimingContext = startQueryTiming(),
): Promise<QueryResult> {
  return executeCached(
    projectId,
    (model: SemanticModel) => ({
      kind: "values",
      attribute: resolveValueAttribute(model, attribute),
      hideUnknown,
    }),
    (model) =>
      compileDistinctValues(
        model,
        resolveValueAttribute(model, attribute),
        hideUnknown,
      ),
    signal,
    timing,
  );
}
