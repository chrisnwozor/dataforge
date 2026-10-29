"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { DashboardQueryController, type DashboardQueryContext } from "@/lib/dashboards/query-controller";

export function useDashboardQueries({ projectId, model, lastSuccessfulRunId, tiles, views, filters, visibleIds, refreshToken = 0 }: DashboardQueryContext) {
  // The server admits one SQL query per project. Keep later tiles local until
  // the preceding tile settles so they do not spend their deadline in its queue.
  const controller = useMemo(() => new DashboardQueryController(projectId, undefined, undefined, 1), [projectId]);
  const context = useMemo(() => ({ projectId, model, lastSuccessfulRunId, tiles, views, filters, visibleIds, refreshToken }), [projectId, model, lastSuccessfulRunId, tiles, views, filters, visibleIds, refreshToken]);
  const states = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => { controller.configure(context); }, [controller, context]);
  useEffect(() => () => controller.dispose(), [controller]);
  return { states, tiles: states, retry: controller.retry, cancel: controller.cancel };
}
