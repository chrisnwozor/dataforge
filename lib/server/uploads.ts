import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import { profileFile } from "@/lib/profiler";
import type { ProfileResult } from "@/lib/profiler";
import { HttpError, boundedBody } from "./http";
import {
  projectUploadDirectory,
  saveProjectProfile,
  profileReport,
  type StoredProject,
} from "./projects";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 128 * 1024;
const uploadFields = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required.")
    .max(80, "Project name must be 80 characters or fewer.")
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Project name contains unsupported characters.",
    ),
  targetDatabase: z.string().trim().max(120).optional(),
});
const csvMimeTypes = new Set([
  "",
  "text/csv",
  "application/csv",
  "text/plain",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);
const xlsxMimeTypes = new Set([
  "",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/zip",
  "application/octet-stream",
]);

export interface CreateProjectResponse {
  project: StoredProject;
  profile: ProfileResult;
}

async function readUploadForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "Send a CSV or XLSX file as multipart form data.");
  }
  try {
    const body = await boundedBody(
      request,
      MAX_MULTIPART_BYTES,
      "The upload is too large. Choose a file no larger than 50 MB.",
    );
    return await new Response(body, {
      headers: { "content-type": contentType },
    }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      "The upload could not be read. Select the file and try again.",
    );
  }
}

async function validateFile(file: File): Promise<"CSV" | "XLSX"> {
  if (file.size === 0) throw new HttpError(400, "The selected file is empty.");
  if (file.size > MAX_UPLOAD_BYTES)
    throw new HttpError(413, "Choose a file no larger than 50 MB.");
  const extension = extname(file.name).toLowerCase();
  const mime = file.type.toLowerCase().split(";")[0].trim();
  if (extension !== ".csv" && extension !== ".xlsx")
    throw new HttpError(415, "Only .csv and .xlsx files are supported.");
  const firstBytes = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  if (extension === ".xlsx") {
    if (
      !xlsxMimeTypes.has(mime) ||
      firstBytes[0] !== 0x50 ||
      firstBytes[1] !== 0x4b ||
      firstBytes[2] !== 0x03 ||
      firstBytes[3] !== 0x04
    ) {
      throw new HttpError(
        415,
        "The selected file is not a valid XLSX workbook.",
      );
    }
    return "XLSX";
  }
  if (!csvMimeTypes.has(mime))
    throw new HttpError(415, "The selected file is not a CSV text file.");
  if (
    firstBytes.some(
      (byte) => byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20),
    )
  ) {
    throw new HttpError(
      415,
      "CSV files must contain UTF-8 text, not binary data.",
    );
  }
  return "CSV";
}

function safeFileName(name: string, sourceType: "CSV" | "XLSX"): string {
  const original = basename(name.replaceAll("\\", "/"));
  const extension = extname(original);
  const stem =
    original
      .slice(0, -extension.length)
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .replace(/^\.+/, "")
      .slice(0, 120)
      .trim() || "source";
  return `${stem}.${sourceType.toLowerCase()}`;
}

export async function createProjectFromUpload(
  request: Request,
): Promise<CreateProjectResponse> {
  const form = await readUploadForm(request);
  if (
    form.getAll("file").length !== 1 ||
    form.getAll("name").length !== 1 ||
    form.getAll("targetDatabase").length > 1
  ) {
    throw new HttpError(400, "Provide one project name and one source file.");
  }
  for (const field of form.keys()) {
    if (!["file", "name", "targetDatabase"].includes(field))
      throw new HttpError(400, "The upload contains an unsupported field.");
  }
  const fields = uploadFields.safeParse({
    name: form.get("name"),
    targetDatabase: form.get("targetDatabase") ?? undefined,
  });
  if (!fields.success)
    throw new HttpError(
      400,
      fields.error.issues[0]?.message ?? "Invalid project details.",
    );
  const file = form.get("file");
  if (!(file instanceof File))
    throw new HttpError(400, "Select a source file to upload.");
  const sourceType = await validateFile(file);
  const id = randomUUID();
  const sourceFile = safeFileName(file.name, sourceType);
  const directory = projectUploadDirectory(id);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  try {
    const filePath = join(/* turbopackIgnore: true */ directory, sourceFile);
    await writeFile(filePath, new Uint8Array(await file.arrayBuffer()), {
      flag: "wx",
    });
    let profile: ProfileResult;
    try {
      profile = await profileFile(filePath, sourceType);
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof Error
          ? error.message
          : "The file could not be profiled.",
      );
    }
    const report = profileReport(profile);
    await writeFile(
      join(directory, "profile-report.json"),
      JSON.stringify(report),
      { flag: "wx" },
    );
    const timestamp = new Date().toISOString();
    const project: StoredProject = {
      id,
      name: fields.data.name,
      sourceFile,
      sourceType,
      status: profile.raggedRowCount > 0 ? "Needs review" : "Ready",
      rowCount: profile.rowCount,
      columnCount: profile.columnCount,
      duplicateRowCount: profile.duplicateRowCount,
      totalNullCells: profile.totalNullCells,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveProjectProfile(project, profile);
    return { project, profile };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
