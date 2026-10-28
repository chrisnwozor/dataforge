import { posix, win32 } from "node:path";
import { sqlLiteral } from "@/lib/sql/helpers";

const projectIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function checkedPath(value: string, label: string): string {
  if (!value || !value.trim()) throw new Error(`${label} is required.`);
  if (value.length > 4_000)
    throw new Error(`${label} must be 4,000 characters or fewer.`);
  if (controls.test(value) || !value.isWellFormed())
    throw new Error(
      `${label} cannot contain control characters or invalid Unicode.`,
    );
  return value;
}

function windowsFolder(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
  );
}

function checkSegments(value: string, windows: boolean, label: string) {
  const segments = value.split(windows ? /[\\/]/ : /\//);
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(
      `${label} cannot contain dot or parent-directory segments.`,
    );
  if (windows) {
    if (/^\\\\[?.]\\/.test(value))
      throw new Error(`${label} cannot use Windows device paths.`);
    const withoutDrive = value.replace(/^[a-z]:/i, "");
    if (/[<>:"|?*]/.test(withoutDrive))
      throw new Error(`${label} contains unsupported Windows path characters.`);
    if (segments.some((segment) => /[ .]$/.test(segment)))
      throw new Error(
        `${label} cannot end a Windows path segment with a space or period.`,
      );
    if (
      segments.some((segment) =>
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
      )
    )
      throw new Error(`${label} cannot use Windows device names.`);
  }
}

export interface StagingPaths {
  /** File path used in BULK INSERT on the SQL Server machine. */
  sqlPath: string;
  /** File path writable by this DataForge Node process. */
  writePath: string;
  directory: string;
}

/** Resolve a shared staging directory without treating a remote Windows path as a local Linux filename. */
export function resolveStagingPaths(
  projectId: string,
  serverFolder: string,
  writeOverride?: string,
  platform: NodeJS.Platform = process.platform,
): StagingPaths {
  if (!projectIdPattern.test(projectId))
    throw new Error("Invalid project ID for the staging file.");
  const folder = checkedPath(serverFolder, "Staging folder");
  const serverWindows = windowsFolder(folder);
  if (!serverWindows && !posix.isAbsolute(folder))
    throw new Error(
      "Staging folder must be an absolute SQL Server path, such as C:\\Temp or /var/opt/mssql/staging.",
    );
  checkSegments(folder, serverWindows, "Staging folder");
  const appWindows = platform === "win32";
  const native = appWindows ? win32 : posix;
  if (writeOverride === undefined && serverWindows !== appWindows)
    throw new Error(
      "The SQL Server staging path is on a different operating system. Mount its shared folder on the app server and set DATAFORGE_STAGING_WRITE_DIR to that local absolute path.",
    );
  const directory = checkedPath(
    writeOverride ?? folder,
    "DataForge staging write folder",
  );
  if (
    !native.isAbsolute(directory) ||
    (appWindows && !windowsFolder(directory))
  )
    throw new Error(
      "DATAFORGE_STAGING_WRITE_DIR must be an absolute path on the DataForge app server.",
    );
  checkSegments(directory, appWindows, "DataForge staging write folder");
  const filename = `${projectId}.csv`;
  return {
    sqlPath: checkedPath(
      (serverWindows ? win32 : posix).join(folder, filename),
      "Staging file path",
    ),
    writePath: checkedPath(
      native.join(directory, filename),
      "DataForge staging file path",
    ),
    directory: native.normalize(directory),
  };
}

/** Paths go only into Unicode SQL string literals, never directly into executable syntax. */
export function sqlPathLiteral(path: string): string {
  return sqlLiteral(checkedPath(path, "Staging file path"));
}
