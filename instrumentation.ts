export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverAbandonedReportRuns } = await import("@/lib/server/reports");
    const { startReportScheduler } = await import("@/lib/server/report-scheduler");
    const { startReportRun } = await import("@/lib/server/report-runner");
    recoverAbandonedReportRuns();
    startReportScheduler((schedule) => startReportRun(schedule.projectId, schedule.reportId, { params: schedule.params, formats: schedule.formats, scheduled: true }));
  }
}
