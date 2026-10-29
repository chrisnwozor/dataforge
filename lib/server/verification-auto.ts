import { authContext, captureJobContext } from "@/lib/auth/context";
import { auditEvent } from "@/lib/auth/audit";
import { readCheckSettings } from "./verification-storage";
/** Optional post-load work cannot change a committed warehouse load's outcome. */
export function scheduleChecksAfterSuccessfulLoad(
  projectId: string,
  sourceRunId: string,
): void {
  try {
    if (!readCheckSettings(projectId).autoAfterLoad) return;
    const context = captureJobContext();
    setImmediate(() => {
      void authContext
        .run(context, () =>
          import("./verification").then(({ maybeRunChecksAfterLoad }) =>
            maybeRunChecksAfterLoad(projectId, sourceRunId),
          ),
        )
        .catch(() => {
          try {
            auditEvent("checks.auto_skipped", "project", projectId, {
              reason:
                "Automatic checks could not start; open Checks and retry.",
            });
          } catch {
            /* The initiating workspace may have been deleted. */
          }
        });
    });
  } catch {
    /* A verification setting/read failure cannot turn a successful SQL load into a failure. */
  }
}
