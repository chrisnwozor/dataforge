import type { CheckRun, CheckSettings } from "@/lib/verify/types";

export interface ChecksResponse {
  runs: CheckRun[];
  settings: CheckSettings;
  activeRunId: string | null;
  latestSourceRunId?: string | null;
  modelVersion?: string | null;
}
export async function checksJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof data?.error === "string"
        ? data.error
        : "The checks request could not be completed. Try again.",
    );
  if (data === null)
    throw new Error("The checks response was incomplete. Try again.");
  return data as T;
}
