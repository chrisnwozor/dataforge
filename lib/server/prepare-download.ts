import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { basename, extname } from "node:path";
import { ensurePreparedDataset } from "./prepare";
import { findProject } from "./projects";
import { HttpError } from "./http";

/** Export the current prepared snapshot; cancelling the body closes its file descriptor. */
export async function preparedSourceResponse(projectId: string, signal?: AbortSignal): Promise<Response> {
  const project = findProject(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  const prepared = await ensurePreparedDataset(projectId, { signal });
  signal?.throwIfAborted();
  const file = createReadStream(/* turbopackIgnore: true */ prepared.filePath, { signal });
  const stem = basename(project.sourceFile, extname(project.sourceFile)).normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "source";
  return new Response(Readable.toWeb(file) as ReadableStream<Uint8Array>, { headers: {
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${stem}_cleaned.csv"`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-DataForge-Pipeline-Version": String(prepared.version),
  } });
}
