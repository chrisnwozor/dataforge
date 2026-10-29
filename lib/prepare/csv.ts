import type { PrepareRow } from "./schema";
/** Canonical staging format: UTF-8, comma delimiter, quoted escapes and LF. */
export function encodeCsvRow(values: readonly unknown[]): Uint8Array {
  return Buffer.from(values.map((value) => {
    const text = String(value ?? "").replace(/\r\n?/g, "\n");
    return /[",\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",") + "\n", "utf8");
}
export async function* rowsToCsv(columns: readonly string[], rows: AsyncIterable<PrepareRow>): AsyncGenerator<Uint8Array> {
  yield encodeCsvRow(columns);
  let chunks: Uint8Array[] = [], bytes = 0;
  for await (const row of rows) {
    const chunk = encodeCsvRow(columns.map((column) => row[column])); chunks.push(chunk); bytes += chunk.byteLength;
    if (chunks.length >= 5_000 || bytes >= 1024 * 1024) { yield Buffer.concat(chunks); chunks = []; bytes = 0; }
  }
  if (chunks.length) yield Buffer.concat(chunks);
}
