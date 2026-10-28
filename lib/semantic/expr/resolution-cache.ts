import type { SemanticModel } from "../types";
import type { ExprType, ResolvedExpr } from "./types";

export interface ResolvedCacheEntry {
  ast: ResolvedExpr;
  type: ExprType;
  dependencies: readonly string[];
  cost: number;
}

const MAX_MODELS = 8;
const MAX_ENTRIES_PER_MODEL = 512;
const MAX_BYTES_PER_MODEL = 2 * 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 512 * 1024;

/** Approximate retained bytes conservatively, including the expanded closure. */
export class ResolutionNamespace {
  readonly model: SemanticModel;
  private readonly entries = new Map<
    string,
    { value: ResolvedCacheEntry; bytes: number }
  >();
  private bytes: number;

  constructor(model: SemanticModel, fingerprintBytes: number) {
    this.bytes = fingerprintBytes;
    // Snapshot metadata once per namespace. Cached ASTs must not keep mutable
    // objects from a caller that can edit a model without changing its version.
    this.model = {
      ...model,
      tables: model.tables.map((table) =>
        Object.freeze({
          ...table,
          columns: Object.freeze(
            table.columns.map((column) => Object.freeze({ ...column })),
          ) as unknown as typeof table.columns,
        }),
      ),
      measures: model.measures.map((measure) => Object.freeze({ ...measure })),
      ...(model.date ? { date: Object.freeze({ ...model.date }) } : {}),
    };
  }

  get(key: string): ResolvedCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: ResolvedCacheEntry): void {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    const bytes = key.length * 2 + value.cost * 160;
    if (bytes > MAX_BYTES_PER_MODEL) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (
      this.entries.size > MAX_ENTRIES_PER_MODEL ||
      this.bytes > MAX_BYTES_PER_MODEL
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
}

const namespaces = new Map<string, ResolutionNamespace>();

/**
 * Persisted versions are normally unique hashes. Including the source model
 * prevents collisions for derived models, callers reusing a version, or tests.
 * This linear fingerprint is computed once by a query's shared resolver.
 */
export function resolutionNamespace(model: SemanticModel): ResolutionNamespace {
  const fingerprint = JSON.stringify(model);
  const existing = namespaces.get(fingerprint);
  if (existing) {
    namespaces.delete(fingerprint);
    namespaces.set(fingerprint, existing);
    return existing;
  }
  const fingerprintBytes = fingerprint.length * 2;
  const retained = fingerprintBytes <= MAX_FINGERPRINT_BYTES;
  const namespace = new ResolutionNamespace(
    model,
    retained ? fingerprintBytes : 0,
  );
  // Very large models remain valid; their resolution cache is request-local.
  if (retained) {
    namespaces.set(fingerprint, namespace);
    while (namespaces.size > MAX_MODELS)
      namespaces.delete(namespaces.keys().next().value!);
  }
  return namespace;
}

export function clearExpressionResolutionCache(): void {
  namespaces.clear();
}
