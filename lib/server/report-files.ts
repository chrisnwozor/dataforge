import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { dataDirectory } from "./db";
import { HttpError } from "./http";

export const reportExportFormatSchema = z.enum(["pdf", "xlsx", "csv"]);
export type ReportExportFormat = z.infer<typeof reportExportFormatSchema>;
const identity = z.string().uuid();

export function sanitizeReportFilename(value: string): string {
  const clean = value.normalize("NFKC").replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "-").replace(/[.\s]+$/g, "").trim().slice(0, 100);
  if (!clean || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) return "report";
  return clean;
}

function validId(value: string): string {
  const result = identity.safeParse(value);
  if (!result.success) throw new HttpError(400, "Invalid report export identity.");
  return result.data;
}

/** Every application-controlled segment is a UUID; never trust stored/client paths. */
function checkedDirectory(segments: string[], create: boolean): string {
  const base = dataDirectory();
  if (create) mkdirSync(/* turbopackIgnore: true */ base, { recursive: true });
  // The configured data root is an administrator choice. Paths below it may not
  // redirect through links, including a pre-existing exports symlink.
  let directory: string;
  try { directory = realpathSync(/* turbopackIgnore: true */ base); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "The report export file is no longer available."); throw error; }
  const root = directory;
  for (const segment of ["exports", ...segments]) {
    directory = join(/* turbopackIgnore: true */ directory, segment);
    if (create) {
      try { mkdirSync(/* turbopackIgnore: true */ directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const info = lstatSync(/* turbopackIgnore: true */ directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new HttpError(400, "Report exports must use a regular directory inside the data folder.");
      const actual = realpathSync(/* turbopackIgnore: true */ directory);
      const nested = relative(root, actual);
      if (nested.startsWith(`..${sep}`) || nested === ".." || resolve(/* turbopackIgnore: true */ root, nested) !== actual) throw new HttpError(400, "The report export path is outside the data folder.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "The report export file is no longer available.");
      throw error;
    }
  }
  return directory;
}

export function reportExportPath(reportId: string, runId: string, format: ReportExportFormat, create = false): string {
  const parsed = reportExportFormatSchema.safeParse(format);
  if (!parsed.success) throw new HttpError(400, "Choose PDF, Excel, or CSV.");
  return join(/* turbopackIgnore: true */ checkedDirectory([validId(reportId), validId(runId)], create), `report.${parsed.data}`);
}

export function writeReportExport(reportId: string, runId: string, format: ReportExportFormat, bytes: Uint8Array): string {
  const path = reportExportPath(reportId, runId, format, true);
  try {
    const info = lstatSync(/* turbopackIgnore: true */ path);
    if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(400, "A report export cannot replace a link or directory.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(/* turbopackIgnore: true */ path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
  return `exports/${reportId}/${runId}/report.${format}`;
}

/** Opens a regular file descriptor so downloads cannot follow a final symlink. */
export function openReportExport(reportId: string, runId: string, format: ReportExportFormat): { fd: number; size: number; path: string } {
  const path = reportExportPath(reportId, runId, format);
  let fd: number;
  try {
    // Windows may not expose O_NOFOLLOW. Check explicitly as well as using it
    // where supported, then verify the opened descriptor is a regular file.
    const entry = lstatSync(/* turbopackIgnore: true */ path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new HttpError(404, "The report export file is no longer available.");
    fd = openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new HttpError(404, "The report export file is no longer available.");
    throw error;
  }
  const info = fstatSync(fd);
  if (!info.isFile()) { closeSync(fd); throw new HttpError(404, "The report export file is unavailable."); }
  return { fd, size: info.size, path };
}

export function removeReportExports(reportId: string, runId?: string): void {
  let directory: string;
  try { directory = checkedDirectory([validId(reportId), ...(runId ? [validId(runId)] : [])], false); }
  catch (error) { if (error instanceof HttpError && error.status === 404) return; throw error; }
  // rm removes an entry which became a symlink without following it. Each parent
  // was verified above; paths are reconstructed rather than loaded from SQLite.
  rmSync(/* turbopackIgnore: true */ directory, { recursive: true, force: true });
}

export function validateStoredExportPath(reportId: string, runId: string, format: ReportExportFormat, value: string): boolean {
  return value === `exports/${validId(reportId)}/${validId(runId)}/report.${reportExportFormatSchema.parse(format)}`;
}

const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;
export function writeReportPreview(reportId: string, runId: string, preview: unknown): void {
  const bytes = Buffer.from(JSON.stringify(preview), "utf8");
  if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new HttpError(413, "The report preview is too large. Narrow its filters or split it into smaller reports.");
  const path = join(/* turbopackIgnore: true */ checkedDirectory([validId(reportId), validId(runId)], true), "preview.json");
  try { const info = lstatSync(/* turbopackIgnore: true */ path); if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(400, "A report preview cannot replace a link or directory."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fd = openSync(/* turbopackIgnore: true */ path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
}
export function readReportPreview(reportId: string, runId: string): unknown | null {
  let path: string;
  try { path = join(/* turbopackIgnore: true */ checkedDirectory([validId(reportId), validId(runId)], false), "preview.json"); }
  catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
  let fd: number;
  try {
    const entry = lstatSync(/* turbopackIgnore: true */ path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new HttpError(400, "A report preview cannot use a link or directory.");
    fd = openSync(/* turbopackIgnore: true */ path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new HttpError(400, "A report preview cannot use a link."); throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_PREVIEW_BYTES) throw new HttpError(413, "The saved report preview is invalid or too large.");
    try { return JSON.parse(readFileSync(/* turbopackIgnore: true */ fd, "utf8")); } catch { throw new HttpError(500, "The saved report preview is invalid. Run the report again."); }
  } finally { closeSync(fd); }
}
