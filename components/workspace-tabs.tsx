"use client";
import { useWorkspaceRole, canAdmin } from "./auth/provider";
import Link from "next/link";
export function WorkspaceTabs({
  active = "projects",
  count,
}: {
  active?: string;
  count?: number;
}) {
  const role = useWorkspaceRole();
  return (
    <nav className="top-tabs" aria-label="Workspace navigation">
      <Link href="/projects" className={active === "projects" ? "active" : ""}>
        Projects{" "}
        {count !== undefined && <span className="tab-count">{count}</span>}
      </Link>
      {canAdmin(role) && <Link href="/settings" className={active === "settings" ? "active" : ""}>
        Settings
      </Link>}
      <Link href="/workspaces" className={active === "workspaces" ? "active" : ""}>Workspaces</Link>
    </nav>
  );
}
