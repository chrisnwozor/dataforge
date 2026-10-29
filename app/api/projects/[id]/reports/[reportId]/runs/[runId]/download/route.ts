import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { errorResponse, HttpError } from "@/lib/server/http";
import { requireModelProject, type ProjectModelContext } from "@/lib/server/model-http";
import { getReport, getReportRun } from "@/lib/server/reports";
import { openReportExport, reportExportFormatSchema, sanitizeReportFilename } from "@/lib/server/report-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = ProjectModelContext & { params: Promise<{ id: string; reportId: string; runId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  try { const id = await requireModelProject(context); const { reportId, runId } = await context.params;
    const format = reportExportFormatSchema.safeParse(new URL(request.url).searchParams.get("format"));
    if (!format.success) throw new HttpError(400, "Choose PDF, Excel, or CSV to download.");
    const report = getReport(id, reportId), run = getReportRun(id, reportId, runId);
    if (run.status !== "succeeded" || !run.filePaths[format.data]) throw new HttpError(404, "This export is unavailable. Run the report with the requested format first.");
    const opened = openReportExport(reportId, runId, format.data);
    const stream = createReadStream(opened.path, { fd: opened.fd, autoClose: true });
    const mime = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv; charset=utf-8" }[format.data];
    const filename = `${sanitizeReportFilename(report.name)}.${format.data}`;
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers: {
      "Content-Type": mime, "Content-Length": String(opened.size), "Content-Disposition": `attachment; filename="report.${format.data}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error, "The report export could not be downloaded."); }
}
