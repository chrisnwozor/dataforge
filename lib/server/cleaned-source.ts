import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
import { detectDelimiter, readFirstWorksheet } from "@/lib/profiler";
import { dataDirectory } from "./db";
import { HttpError, projectIdSchema } from "./http";
import { findProject, projectUploadDirectory } from "./projects";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

function encodeRow(values: readonly unknown[]): Uint8Array {
  const cells = values.map((value) => {
    const text = (
      value instanceof Date ? value.toISOString() : String(value ?? "")
    ).replace(/\r\n?/g, "\n");
    return /[",\n]|^\s|\s$/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  });
  return Buffer.from(`${cells.join(",")}\n`, "utf8");
}

/** A retained source may be restored manually, so check its real filesystem location too. */
async function sourceFilePath(projectId: string): Promise<string> {
  const project = findProject(projectId)!;
  const directory = projectUploadDirectory(projectId);
  if (
    !project.sourceFile ||
    /[\\/:\u0000]/.test(project.sourceFile) ||
    basename(project.sourceFile) !== project.sourceFile ||
    project.sourceFile === "." ||
    project.sourceFile === ".."
  )
    throw new HttpError(
      422,
      "The retained source file path is invalid. Re-import this project.",
    );
  try {
    const [filePath, realDirectory, uploadsRoot] = await Promise.all([
      realpath(join(directory, project.sourceFile)),
      realpath(directory),
      realpath(join(dataDirectory(), "uploads")),
    ]);
    if (
      dirname(filePath) !== realDirectory ||
      dirname(realDirectory) !== uploadsRoot
    )
      throw new HttpError(
        422,
        "The retained source file must stay inside its project upload directory.",
      );
    const information = await stat(filePath);
    if (!information.isFile() || information.size > MAX_SOURCE_BYTES)
      throw new HttpError(
        422,
        "The retained source must be a file no larger than 50 MB.",
      );
    return filePath;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      422,
      "The original source file is unavailable. Restore it in data/uploads or re-import the project.",
    );
  }
}

interface RowSource {
  rows: AsyncGenerator<unknown[]>;
  close(): Promise<void>;
}

async function openCsvRows(filePath: string): Promise<RowSource> {
  const source = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  // Attach the close promise before the first read so cancellation can await handle release.
  const closed = new Promise<void>((resolve) => source.once("close", resolve));
  const iterator = source[Symbol.asyncIterator]();
  let parser: ReturnType<typeof parse> | undefined;
  let replay: Readable | undefined;
  let pumping: Promise<void> | undefined;
  let cancelled = false;
  async function close() {
    cancelled = true;
    parser?.destroy();
    replay?.destroy();
    source.destroy();
    await pumping;
    await closed;
  }
  try {
    const first = await iterator.next();
    if (first.done) throw new Error("The source file is empty.");
    const firstChunk = Buffer.from(first.value as Uint8Array);
    if (
      (firstChunk[0] === 0xff && firstChunk[1] === 0xfe) ||
      (firstChunk[0] === 0xfe && firstChunk[1] === 0xff)
    )
      throw new Error("CSV files must use UTF-8 text encoding.");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    async function* chunks() {
      let next: IteratorResult<unknown> = { done: false, value: firstChunk };
      while (!next.done && !cancelled) {
        const chunk = Buffer.from(next.value as Uint8Array);
        for (const byte of chunk)
          if (
            (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) ||
            byte === 127
          )
            throw new Error(
              "The retained CSV contains unsupported control characters.",
            );
        decoder.decode(chunk, { stream: true });
        yield chunk;
        next = await iterator.next();
      }
      if (!cancelled) decoder.decode();
    }
    parser = parse({
      bom: true,
      delimiter: detectDelimiter(
        firstChunk.toString("utf8").replace(/^\uFEFF/, ""),
      ),
      columns: false,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: MAX_SOURCE_BYTES,
    });
    replay = Readable.from(chunks());
    pumping = pipeline(replay, parser).catch((error: unknown) => {
      if (!cancelled)
        parser?.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
    });
    const records = parser[Symbol.asyncIterator]();
    const header = await records.next();
    if (header.done) throw new Error("The source file has no header row.");
    const fields = header.value as unknown[];
    if (!fields.length || fields.every((value) => !String(value ?? "").trim()))
      throw new Error("The source file must have a non-empty header row.");
    if (fields.length > 10_000)
      throw new Error("The source file exceeds 10,000 columns.");
    const rows = (async function* () {
      try {
        yield fields;
        for (;;) {
          const record = await records.next();
          if (record.done) break;
          const raw = record.value as unknown[];
          yield Array.from(
            { length: fields.length },
            (_, ordinal) => raw[ordinal] ?? "",
          );
        }
        await pumping;
      } finally {
        await close();
      }
    })();
    return { rows, close };
  } catch (error) {
    await close();
    throw new HttpError(
      422,
      error instanceof Error
        ? `The retained CSV could not be read: ${error.message}`
        : "The retained CSV could not be read.",
    );
  }
}

async function openWorkbookRows(filePath: string): Promise<RowSource> {
  try {
    const { sheet, range } = await readFirstWorksheet(filePath);
    const XLSX = await import("xlsx");
    let cancelled = false;
    const rows = (async function* () {
      for (let row = range.s.r; row <= range.e.r && !cancelled; row++) {
        const values: unknown[] = [];
        let hasValue = false;
        for (let column = range.s.c; column <= range.e.c; column++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          const value =
            cell?.t === "e" ? (cell.w ?? String(cell.v)) : (cell?.v ?? "");
          if (value !== "" && value !== null && value !== undefined)
            hasValue = true;
          values.push(value);
        }
        if (hasValue) yield values;
      }
    })();
    return {
      rows,
      async close() {
        cancelled = true;
      },
    };
  } catch (error) {
    throw new HttpError(
      422,
      error instanceof Error
        ? `The retained workbook could not be read: ${error.message}`
        : "The retained workbook could not be read.",
    );
  }
}

/** Export one row per pull; cancellation closes the source before it resolves. */
export async function cleanedSourceResponse(
  projectId: string,
): Promise<Response> {
  if (!projectIdSchema.safeParse(projectId).success)
    throw new HttpError(400, "Invalid project ID.");
  const project = findProject(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  const filePath = await sourceFilePath(projectId);
  const source =
    project.sourceType === "XLSX"
      ? await openWorkbookRows(filePath)
      : await openCsvRows(filePath);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await source.rows.next();
          if (cancelled) return;
          if (next.done) controller.close();
          else controller.enqueue(encodeRow(next.value));
        } catch (error) {
          if (!cancelled) controller.error(error);
          await source.close();
        }
      },
      async cancel() {
        cancelled = true;
        await source.close();
        await source.rows.return(undefined);
      },
    },
    { highWaterMark: 1 },
  );
  const stem =
    basename(project.sourceFile, extname(project.sourceFile))
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 100) || "source";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${stem}_cleaned.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
