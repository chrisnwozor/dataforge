import { z } from "zod";
import { nextCronRun, parseCron, validateReportTimezone } from "@/lib/reports/cron";
import { validateReportParameters } from "@/lib/reports/parameters";
import { reportParameterValuesSchema } from "@/lib/reports/schema";
import { HttpError } from "./http";
import { reportExportFormatSchema } from "./report-files";
import { getReport, reportScheduleInputSchema, type ReportSchedule } from "./reports";

// next/last timestamps are server-owned and never accepted from a client.
const publicSchema = z.object({
  cron: z.string().trim().min(1).max(120), timezone: z.string().min(1).max(100),
  params: reportParameterValuesSchema, formats: z.array(reportExportFormatSchema).min(1).max(3), enabled: z.boolean(),
}).strict();

export function prepareReportSchedule(projectId: string, reportId: string, input: unknown, saved?: ReportSchedule, now = new Date()): z.infer<typeof reportScheduleInputSchema> {
  const schema = saved ? publicSchema.partial().refine((value) => Object.keys(value).length > 0, "Provide schedule edits.") : publicSchema.extend({ params: reportParameterValuesSchema.default({}), enabled: z.boolean().default(true) });
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "Provide a five-field cron expression, timezone, parameters, and export formats.");
  const report = getReport(projectId, reportId);
  const value = { cron: saved?.cron, timezone: saved?.timezone, params: saved?.params, formats: saved?.formats, enabled: saved?.enabled, ...parsed.data };
  try {
    const cron = parseCron(value.cron!).expression;
    const timezone = validateReportTimezone(value.timezone!);
    const params = validateReportParameters(report.definition, value.params ?? {});
    const enabled = value.enabled ?? true;
    const changed = !saved || cron !== saved.cron || timezone !== saved.timezone || enabled !== saved.enabled;
    return reportScheduleInputSchema.parse({ cron, timezone, params, formats: value.formats, enabled,
      lastRunAt: saved?.lastRunAt ?? null,
      nextRunAt: !enabled ? null : changed ? nextCronRun(cron, timezone, now).toISOString() : saved!.nextRunAt ?? nextCronRun(cron, timezone, now).toISOString(),
    });
  } catch (error) {
    throw new HttpError(400, error instanceof z.ZodError ? "Check the schedule's parameters and export formats." : error instanceof Error ? error.message : "The schedule is invalid.");
  }
}
