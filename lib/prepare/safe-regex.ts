import { Worker } from "node:worker_threads";
import { join } from "node:path";

export const REGEX_TIMEOUT_MS = 100;
export const REGEX_PATTERN_LIMIT = 256;
export const REGEX_INPUT_LIMIT = 1024 * 1024;
const MAX_QUEUED = 128;
export class SafeRegexError extends Error { constructor(message: string) { super(message); this.name = "SafeRegexError"; } }
export class RegexTimeoutError extends SafeRegexError { constructor() { super("Regex exceeded its 100 ms per-row time limit. Use a simpler pattern or shorter values."); this.name = "RegexTimeoutError"; } }
export interface SafeRegex {
  test(text: string, signal?: AbortSignal): Promise<boolean>;
  replace(text: string, replacement: string, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
interface Job { id: number; pattern: string; flags: string; operation: "test" | "replace"; text: string; replacement?: string; signal?: AbortSignal; abort: () => void; resolve(value: boolean | string): void; reject(reason: Error): void; settled: boolean; timer?: ReturnType<typeof setTimeout> }
interface Slot { worker: Worker; ready: boolean; closed: boolean; job?: Job; stopping?: Promise<number>; startupTimer?: ReturnType<typeof setTimeout> }
const queue: Job[] = [], slots = new Set<Slot>();
let nextId = 0, leases = 0, generation = 0;
const abortError = () => new DOMException("Regex operation cancelled.", "AbortError");
function settle(job: Job, value?: boolean | string, error?: Error) {
  if (job.settled) return;
  job.settled = true; clearTimeout(job.timer); job.signal?.removeEventListener("abort", job.abort);
  if (error) job.reject(error); else job.resolve(value!);
}
async function stop(slot: Slot, error?: Error): Promise<void> {
  if (slot.closed) { await slot.stopping; return; }
  slot.closed = true; slot.worker.ref();
  clearTimeout(slot.startupTimer);
  if (slot.job) { settle(slot.job, undefined, error ?? abortError()); slot.job = undefined; }
  slot.stopping = slot.worker.terminate();
  try { await slot.stopping; } finally { slots.delete(slot); if (leases) pump(); }
}
function createSlot() {
  const worker = new Worker(join(process.cwd(), "lib", "prepare", "regex-worker.js"), { resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } });
  const slot: Slot = { worker, ready: false, closed: false }; slots.add(slot);
  const startupFailure = () => {
    if (slot.closed) return;
    const error = new SafeRegexError("The isolated regex service could not start. Restart DataForge or rebuild the application.");
    for (const job of queue.splice(0)) settle(job, undefined, error);
    void stop(slot, error);
  };
  slot.startupTimer = setTimeout(startupFailure, 5_000);
  worker.on("message", (message: { ready?: boolean; id?: number; value?: boolean | string; error?: string }) => {
    if (slot.closed) return;
    if (message.ready) { clearTimeout(slot.startupTimer); slot.ready = true; pump(); if (!slot.job) worker.unref(); return; }
    const job = slot.job;
    if (!job || message.id !== job.id) return;
    slot.job = undefined; worker.unref();
    settle(job, message.value, message.error ? new SafeRegexError(message.error) : undefined); pump();
  });
  worker.on("error", (error) => { if (slot.closed) return; if (!slot.ready) { startupFailure(); return; } void stop(slot, new SafeRegexError(error.message.includes("memory") ? "Regex exceeded its bounded worker memory. Use a simpler pattern or shorter values." : "The isolated regex worker could not complete this pattern.")); });
  worker.on("exit", (code) => { if (!slot.closed) { if (!slot.ready) startupFailure(); else void stop(slot, new SafeRegexError(`The isolated regex worker stopped (code ${code}). Try a simpler pattern.`)); } });
  return slot;
}
function pump() {
  while (queue.length && leases) {
    const slot = [...slots].find((entry) => entry.ready && !entry.closed && !entry.job);
    if (!slot) {
      if (slots.size < 2) try { createSlot(); } catch {
        const error = new SafeRegexError("The isolated regex service could not start. Restart DataForge or rebuild the application.");
        for (const job of queue.splice(0)) settle(job, undefined, error);
      }
      break;
    }
    const job = queue.shift()!;
    if (job.settled || job.signal?.aborted) { settle(job, undefined, abortError()); continue; }
    slot.job = job;
    // Startup is outside the row guard: only execution after worker ready counts.
    job.timer = setTimeout(() => { void stop(slot!, new RegexTimeoutError()); }, REGEX_TIMEOUT_MS);
    slot.worker.ref();
    slot.worker.postMessage({ id: job.id, pattern: job.pattern, flags: job.flags, operation: job.operation, text: job.text, replacement: job.replacement });
  }
}
function submit(pattern: string, flags: string, operation: "test" | "replace", text: string, replacement?: string, signal?: AbortSignal): Promise<boolean | string> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof text !== "string" || text.length > REGEX_INPUT_LIMIT) return Promise.reject(new SafeRegexError("Regex input is limited to 1 MB per cell. Narrow the value before applying regex."));
  if (replacement !== undefined && (typeof replacement !== "string" || replacement.length > 4096)) return Promise.reject(new SafeRegexError("Regex replacement text is limited to 4,096 characters."));
  if (queue.length >= MAX_QUEUED) return Promise.reject(new SafeRegexError("The regex queue is full. Run fewer pipelines concurrently."));
  return new Promise((resolve, reject) => {
    const job: Job = { id: ++nextId, pattern, flags, operation, text, replacement, signal, resolve, reject, settled: false, abort: () => {} };
    job.abort = () => {
      const slot = [...slots].find((entry) => entry.job === job);
      if (slot) void stop(slot, abortError());
      else { const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1); settle(job, undefined, abortError()); }
    };
    signal?.addEventListener("abort", job.abort, { once: true }); queue.push(job); pump();
  });
}

/** Patterns are data for a bounded fixed worker, never JavaScript or main-thread regex execution. */
export async function compileSafeRegex(pattern: string, flags = ""): Promise<SafeRegex> {
  if (typeof pattern !== "string" || pattern.length > REGEX_PATTERN_LIMIT) throw new SafeRegexError("Regex patterns may contain at most 256 characters.");
  if (typeof flags !== "string" || !/^[gimsu]*$/.test(flags) || new Set(flags).size !== flags.length) throw new SafeRegexError("Use each supported regex flag (g, i, m, s, u) at most once.");
  if (/\\(?:[1-9]|k<)/.test(pattern)) throw new SafeRegexError("Regex backreferences are not supported. Use a simpler pattern.");
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) throw new SafeRegexError("Nested regex quantifiers are not supported. Use a simpler pattern.");
  try { new RegExp(pattern, flags); } catch { throw new SafeRegexError("The regex pattern is invalid."); }
  leases++; const leaseGeneration = generation;
  let closed = false;
  const own = new Set<Promise<unknown>>();
  const run = <T extends string | boolean>(operation: "test" | "replace", text: string, replacement?: string, signal?: AbortSignal): Promise<T> => {
    if (closed || leaseGeneration !== generation) return Promise.reject(new SafeRegexError("This regex has been closed."));
    const promise = submit(pattern, flags, operation, text, replacement, signal) as Promise<T>;
    own.add(promise); void promise.finally(() => own.delete(promise)).catch(() => {}); return promise;
  };
  return {
    test: (text, signal) => run<boolean>("test", text, undefined, signal),
    replace: (text, replacement, signal) => run<string>("replace", text, replacement, signal),
    async close() {
      if (closed || leaseGeneration !== generation) return; closed = true;
      await Promise.allSettled([...own]);
      if (--leases === 0) { for (const job of queue.splice(0)) settle(job, undefined, abortError()); await Promise.all([...slots].map((slot) => stop(slot))); }
    },
  };
}
/** Test/process shutdown helper; normal callers close their compiled handles. */
export async function closeRegexWorkers(): Promise<void> {
  generation++; leases = 0; for (const job of queue.splice(0)) settle(job, undefined, abortError());
  await Promise.all([...slots].map((slot) => stop(slot)));
}
