import { basename, join, relative, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import { dataDirectory, getDatabase } from "@/lib/server/db";
import { findProject, projectUploadDirectory } from "@/lib/server/projects";
import { readPipeline } from "@/lib/server/prepare-storage";
import { HttpError } from "@/lib/server/http";
export class PreparedSnapshotUnavailable extends Error {}
/** Use the immutable CSV actually staged by this load, never rerun an edited pipeline. */
export async function preparedSnapshotPath(
  projectId: string,
  loadId: string | null,
): Promise<string> {
  const project = findProject(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  const pipeline = readPipeline(projectId);
  let file: string;
  if (loadId) {
    const run = getDatabase()
      .prepare(
        "SELECT id,pipeline_version FROM pipeline_quality_runs WHERE project_id=? AND warehouse_run_id=? AND status='succeeded' ORDER BY started_at DESC,id LIMIT 1",
      )
      .get(projectId, loadId);
    if (!run)
      throw new PreparedSnapshotUnavailable(
        "This load has no retained prepared CSV snapshot. Run a new load to reconcile ingestion against its exact input.",
      );
    if (
      !pipeline ||
      Number(run.pipeline_version) !== pipeline.version ||
      pipeline.profiledVersion !== pipeline.version
    )
      throw new PreparedSnapshotUnavailable(
        "The preparation pipeline changed after the last successful load. Load its current version before reconciling its columns.",
      );
    file = join(
      /* turbopackIgnore: true */ projectUploadDirectory(projectId),
      "prepared",
      "runs",
      z.string().uuid().parse(run.id),
      "prepared.csv",
    );
  } else if (pipeline) {
    const row = getDatabase()
      .prepare(
        "SELECT prepared_path FROM project_pipelines WHERE project_id=? AND profiled_version=version AND status='succeeded'",
      )
      .get(projectId);
    if (!row?.prepared_path)
      throw new PreparedSnapshotUnavailable(
        "Prepare the current pipeline to retain a CSV snapshot before checking ingestion.",
      );
    file = String(row.prepared_path);
  } else {
    if (
      project.sourceType !== "CSV" ||
      basename(project.sourceFile) !== project.sourceFile ||
      /[\\/:\u0000]/.test(project.sourceFile)
    )
      throw new PreparedSnapshotUnavailable(
        "Prepare this source to create a CSV snapshot. Checks never re-run or change the pipeline.",
      );
    file = join(
      /* turbopackIgnore: true */ projectUploadDirectory(projectId),
      project.sourceFile,
    );
  }
  const root = await realpath(/* turbopackIgnore: true */ dataDirectory());
  const pathRoot = await realpath(
    /* turbopackIgnore: true */ projectUploadDirectory(projectId),
  ).catch(() => {
    throw new PreparedSnapshotUnavailable(
      "The project's input directory is unavailable. Restore its retained files before checking ingestion.",
    );
  });
  const projectRelative = relative(/* turbopackIgnore: true */ root, pathRoot);
  if (projectRelative.startsWith("..") || !projectRelative)
    throw new HttpError(
      422,
      "Prepared snapshots must stay inside their project.",
    );
  const absolute = await realpath(/* turbopackIgnore: true */ file).catch(
    () => {
      throw new PreparedSnapshotUnavailable(
        "The retained prepared CSV is missing. Restore it or run a new load; current data has not been substituted for the missing snapshot.",
      );
    },
  );
  const inside = relative(/* turbopackIgnore: true */ pathRoot, absolute);
  if (inside === ".." || inside.startsWith(`..${sep}`) || !inside)
    throw new HttpError(422, "The prepared snapshot is outside its project.");
  let current = dataDirectory();
  for (const segment of relative(
    /* turbopackIgnore: true */ dataDirectory(),
    file,
  ).split(sep)) {
    if (segment === "..")
      throw new HttpError(422, "Invalid prepared snapshot path.");
    current = join(/* turbopackIgnore: true */ current, segment);
    const info = await lstat(/* turbopackIgnore: true */ current);
    if (info.isSymbolicLink())
      throw new HttpError(422, "Prepared snapshots cannot use symbolic links.");
  }
  if (!(await lstat(/* turbopackIgnore: true */ absolute)).isFile())
    throw new PreparedSnapshotUnavailable(
      "The prepared snapshot is not a regular CSV file.",
    );
  return absolute;
}
