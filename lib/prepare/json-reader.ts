import { createReadStream } from "node:fs";
import type { Cell, PrepareRow } from "./schema";

const MAX_DEPTH = 32;
const MAX_VALUE_CHARACTERS = 2 * 1024 * 1024;

/** A pull-driven JSON cursor. Breaking a preview closes the file before reading its tail. */
class JsonCursor {
  private source;
  private iterator;
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";
  private index = 0;
  private ended = false;
  private rowBudget: number | null = null;
  private firstChunk = true;
  constructor(path: string, private signal?: AbortSignal) {
    this.source = createReadStream(/* turbopackIgnore: true */ path, { highWaterMark: 16 * 1024, signal });
    this.iterator = this.source[Symbol.asyncIterator]();
  }
  async peek(): Promise<string> {
    this.signal?.throwIfAborted();
    while (this.index >= this.buffer.length && !this.ended) {
      const next = await this.iterator.next();
      this.ended = next.done === true;
      this.buffer = next.done ? this.decoder.decode() : this.decoder.decode(next.value, { stream: true });
      this.index = 0;
      if (this.firstChunk && this.buffer.length) { if (this.buffer.charCodeAt(0) === 0xfeff) this.index++; this.firstChunk = false; }
    }
    return this.buffer[this.index] ?? "";
  }
  async take(): Promise<string> {
    const character = await this.peek();
    if (character) {
      this.index++;
      if (this.rowBudget !== null && --this.rowBudget < 0) throw new Error("A JSON row exceeds the 2 MB record budget. Reduce the source columns.");
    }
    return character;
  }
  async space(): Promise<void> { while (/\s/.test(await this.peek()) && await this.peek()) this.index++; }
  async expect(character: string): Promise<void> {
    await this.space();
    if (await this.take() !== character) throw new Error(`Invalid JSON: expected ${character}.`);
  }
  async string(): Promise<string> {
    await this.expect('"');
    let raw = '"', escaped = false;
    for (;;) {
      const character = await this.take();
      if (!character) throw new Error("Invalid JSON: unterminated string.");
      raw += character;
      if (raw.length > MAX_VALUE_CHARACTERS) throw new Error("A JSON string exceeds the 2 MB value budget. Reduce the source columns or use a smaller file.");
      if (character === '"' && !escaped) break;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
    }
    try { return JSON.parse(raw) as string; } catch { throw new Error("Invalid JSON string escape or control character."); }
  }
  async value(depth = 0, materialize = true): Promise<unknown> {
    if (depth > MAX_DEPTH) throw new Error("JSON nesting exceeds 32 levels.");
    await this.space(); const character = await this.peek();
    if (character === '"') return this.string();
    if (character === "{" || character === "[") {
      const object = character === "{";
      await this.take(); await this.space();
      const result: unknown[] | Record<string, unknown> = object ? Object.create(null) : [];
      const seen = new Set<string>(); let entries = 0;
      const end = object ? "}" : "]";
      if (await this.peek() === end) { await this.take(); return result; }
      for (;;) {
        if (++entries > 100_000) throw new Error("A JSON value exceeds the 100,000-item budget. Reduce the source or select a narrower array path.");
        let key = "";
        if (object) {
          key = await this.string(); await this.expect(":");
          if (seen.has(key)) throw new Error(`Duplicate JSON object key: ${key}.`);
          seen.add(key);
        }
        const value = await this.value(depth + 1, materialize);
        if (materialize) { if (object) (result as Record<string, unknown>)[key] = value; else (result as unknown[]).push(value); }
        await this.space(); const separator = await this.take();
        if (separator === end) return result;
        if (separator !== ",") throw new Error(`Invalid JSON: expected a comma or ${end}.`);
      }
    }
    let raw = "";
    while (await this.peek() && !/[\s,\]}]/.test(await this.peek())) {
      raw += await this.take();
      if (raw.length > 1_000) throw new Error("A JSON literal is too long.");
    }
    if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(raw)) throw new Error("Invalid JSON value.");
    const value = JSON.parse(raw);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("JSON numbers must be finite.");
    if (/^-?\d+$/.test(raw) && typeof value === "number" && !Number.isSafeInteger(value)) return raw;
    return value;
  }
  async *arrayAt(path: string[], depth = 0): AsyncGenerator<unknown> {
    if (depth > MAX_DEPTH) throw new Error("JSON nesting exceeds 32 levels.");
    await this.space();
    if (!path.length) {
      await this.expect("["); await this.space();
      if (await this.peek() === "]") { await this.take(); return; }
      for (;;) {
        this.rowBudget = MAX_VALUE_CHARACTERS;
        const row = await this.value(depth + 1);
        this.rowBudget = null;
        yield row;
        await this.space(); const separator = await this.take();
        if (separator === "]") return;
        if (separator !== ",") throw new Error("Invalid JSON array separator.");
      }
    }
    await this.expect("{"); await this.space();
    let found = false; const keys = new Set<string>();
    if (await this.peek() === "}") { await this.take(); throw new Error("The JSON array path does not exist."); }
    for (;;) {
      const key = await this.string();
      if (keys.has(key)) throw new Error(`Duplicate JSON object key: ${key}.`);
      keys.add(key); if (keys.size > 10_000) throw new Error("A JSON object has more than 10,000 properties.");
      await this.expect(":");
      if (key === path[0]) { found = true; yield* this.arrayAt(path.slice(1), depth + 1); }
      else await this.value(depth + 1, false);
      await this.space(); const separator = await this.take();
      if (separator === "}") break;
      if (separator !== ",") throw new Error("Invalid JSON object separator.");
    }
    if (!found) throw new Error("The JSON array path does not exist.");
  }
  async finish(): Promise<void> { await this.space(); if (await this.peek()) throw new Error("Unexpected content after the JSON document."); }
  async close(): Promise<void> { this.source.destroy(); await this.iterator.return?.(); }
}

export function jsonArrayPath(value = ""): string[] {
  const path = value.replace(/^\$\.?/, "");
  if (!path) return [];
  const parts = path.split(".");
  if (parts.length > 16 || parts.some((part) => !part || part.length > 256 || /[\u0000-\u001f]/.test(part))) throw new Error("Use a dot-separated JSON array path with at most sixteen levels, such as data.orders.");
  return parts;
}

export function flattenJsonObject(input: unknown, separator = " | ", onWarning?: (message: string) => void): PrepareRow {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Each selected JSON array item must be an object.");
  const output: PrepareRow = Object.create(null);
  let columns = 0;
  const add = (name: string, value: Cell) => {
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("A flattened JSON column name is empty, too long, or contains control characters.");
    if (Object.hasOwn(output, name)) throw new Error(`Flattened JSON columns collide at ${name}. Rename the original property.`);
    output[name] = value;
    if (++columns > 10_000) throw new Error("JSON records may contain at most 10,000 flattened columns.");
  };
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error("JSON nesting exceeds 32 levels.");
    if (Array.isArray(value)) {
      if (value.some((entry) => entry !== null && typeof entry === "object")) { onWarning?.(`Ignored array of objects in ${prefix}. Select that array as a separate source if needed.`); return; }
      add(prefix, value.map((entry) => entry === null ? "" : String(entry)).join(separator));
    } else if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) visit(entry, prefix ? `${prefix}.${key}` : key, depth + 1);
    } else if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) add(prefix, value);
    else throw new Error("JSON source values must be text, finite numbers, booleans, or NULL.");
  };
  visit(input, "", 0);
  return output;
}

export async function* readJsonRows(path: string, options: { arrayPath?: string; arraySeparator?: string; limit?: number; signal?: AbortSignal; onWarning?: (message: string) => void } = {}): AsyncGenerator<PrepareRow> {
  const cursor = new JsonCursor(path, options.signal);
  let rows = 0;
  try {
    for await (const input of cursor.arrayAt(jsonArrayPath(options.arrayPath))) {
      options.signal?.throwIfAborted();
      yield flattenJsonObject(input, options.arraySeparator, options.onWarning);
      if (++rows >= (options.limit ?? 5_000_000)) { if (options.limit === undefined) throw new Error("JSON sources are limited to 5,000,000 rows."); return; }
    }
    await cursor.finish();
  } finally { await cursor.close(); }
}
