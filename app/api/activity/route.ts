import { withWorkspaceRoute } from "@/lib/auth/guards";
import { readAuthBody } from "@/lib/auth/http";
import { auditEvent, pruneAudit, readAudit } from "@/lib/auth/audit";
import { setAuditRetention } from "@/lib/auth/workspaces";
import { z } from "zod";
export const GET = withWorkspaceRoute("admin", async (request: Request) => {
  const search = new URL(request.url).searchParams;
  const filters = z
    .object({
      action: z.string().max(100).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
    })
    .parse(
      Object.fromEntries(
        ["action", "from", "to"].flatMap((key) =>
          search.get(key) ? [[key, search.get(key)]] : [],
        ),
      ),
    );
  pruneAudit();
  const csv = search.get("format") === "csv",
    events = readAudit({ ...filters, limit: csv ? 10000 : 200 });
  if (!csv) return Response.json({ events });
  auditEvent("export.downloaded", "audit", null, {
    format: "csv",
    count: events.length,
  });
  const cell = (value: unknown) =>
    '"' +
    String(value ?? "")
      .replace(/^[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  return new Response(
    [
      "Created,User,Action,Target,IP,Metadata",
      ...events.map((e) =>
        [
          e.createdAt,
          e.userName,
          e.action,
          e.targetId,
          e.ip,
          JSON.stringify(e.metadata),
        ]
          .map(cell)
          .join(","),
      ),
    ].join("\n") + "\n",
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dataforge-activity.csv"',
      },
    },
  );
});
export const PUT = withWorkspaceRoute("admin", async (request: Request) => {
  setAuditRetention(
    z
      .object({ days: z.number().int().min(1).max(3650) })
      .strict()
      .parse(await readAuthBody(request)).days,
  );
  pruneAudit();
  return Response.json({ success: true });
});
