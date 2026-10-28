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
import { getSemanticModel, requireSemanticReady } from "./semantic";
import { executeCompiledQuery, QueryAbortedError } from "./query-transport";

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
): Promise<QueryResult> {
  if (signal?.aborted) throw new HttpError(499, "The query was cancelled.");
  const ready = await requireSemanticReady(projectId);
  const model = await getSemanticModel(projectId);
  const connectionVersion = readPublicConnection().updatedAt ?? "";
  const namespace = normalizedJson([
    ready.run.id,
    model.version,
    connectionVersion,
  ]);
  semanticCache.useNamespace(projectId, namespace);
  let compiled: CompiledQuery;
  try {
    compiled = build(model);
  } catch (error) {
    compilationError(error);
  }
  const cacheInput = typeof input === "function" ? input(model) : input;
  const key = resultCacheKey(
    projectId,
    ready.run.id,
    model.version,
    cacheInput,
    connectionVersion,
  );
  const cacheStart = performance.now();
  const cached = semanticCache.get(key);
  if (cached)
    return {
      ...cached,
      fromCache: true,
      elapsedMs: Math.round((performance.now() - cacheStart) * 100) / 100,
    };
  const start = performance.now();
  try {
    const rows = await executeCompiledQuery(ready.settings, compiled, signal);
    const result = resultFromRows(
      compiled,
      rows,
      Math.round((performance.now() - start) * 100) / 100,
    );
    // Avoid caching an old snapshot if a load/semantic edit finished in flight.
    const current = await requireSemanticReady(projectId);
    const currentModel = await getSemanticModel(projectId);
    if (
      current.run.id === ready.run.id &&
      currentModel.version === model.version &&
      (readPublicConnection().updatedAt ?? "") === connectionVersion
    )
      semanticCache.set(key, result, projectId);
    return result;
  } catch (error) {
    executionError(error, ready.settings.password, signal);
  }
}

export async function runSemanticQuery(
  projectId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<QueryResult> {
  let normalized;
  try {
    normalized = normalizeQuery(input);
  } catch (error) {
    compilationError(error);
  }
  return executeCached(
    projectId,
    { kind: "query", query: normalized },
    (model) => compileQuery(model, normalized),
    signal,
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
  );
}
