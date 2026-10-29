import { pruneAudit } from "./audit";
const state = globalThis as typeof globalThis & {
  dataforgeAuditRetention?: ReturnType<typeof setInterval>;
};
/** Process maintenance only: no user-controlled workspace, metadata or SQL. */
export function startAuditRetention(): void {
  if (state.dataforgeAuditRetention) return;
  pruneAudit();
  state.dataforgeAuditRetention = setInterval(() => {
    try {
      pruneAudit();
    } catch {
      console.warn("[DataForge] Audit retention will retry next hour.");
    }
  }, 3600_000);
  state.dataforgeAuditRetention.unref?.();
}
