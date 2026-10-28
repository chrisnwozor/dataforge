import { isTerminalRun } from "@/lib/runner/types";
import { errorResponse } from "@/lib/server/http";
import {
  requireProjectRun,
  type ProjectRunContext,
} from "@/lib/server/run-http";
import { getRunDetail } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: ProjectRunContext,
): Promise<Response> {
  try {
    const { runId } = await requireProjectRun(context);
    const encoder = new TextEncoder();
    let stop: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let previous = "";
        let lastHeartbeat = Date.now();
        stop = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          request.signal.removeEventListener("abort", onAbort);
        };
        const close = () => {
          if (closed) return;
          stop();
          controller.close();
        };
        const onAbort = () => close();
        function publish(initial = false) {
          if (closed) return;
          if (!initial && (controller.desiredSize ?? 0) <= 0) return;
          try {
            const detail = getRunDetail(runId);
            if (!detail) {
              close();
              return;
            }
            const json = JSON.stringify(detail);
            if (initial || json !== previous) {
              const event = initial ? "snapshot" : "run";
              const lastLogId = detail.logs.at(-1)?.id ?? 0;
              controller.enqueue(
                encoder.encode(
                  `id: ${lastLogId}\nevent: ${event}\ndata: ${json}\n\n`,
                ),
              );
              previous = json;
              lastHeartbeat = Date.now();
            } else if (Date.now() - lastHeartbeat >= 10_000) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastHeartbeat = Date.now();
            }
            if (isTerminalRun(detail.run.status)) close();
          } catch {
            close();
          }
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          close();
          return;
        }
        publish(true);
        if (!closed) timer = setInterval(() => publish(), 500);
      },
      cancel() {
        stop();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(
      error,
      "Live progress could not be opened. Use polling instead.",
    );
  }
}
