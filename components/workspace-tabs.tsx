import Link from "next/link";
export function WorkspaceTabs({
  active = "projects",
  count,
}: {
  active?: string;
  count?: number;
}) {
  return (
    <nav className="top-tabs" aria-label="Workspace navigation">
      <Link href="/projects" className={active === "projects" ? "active" : ""}>
        Projects{" "}
        {count !== undefined && <span className="tab-count">{count}</span>}
      </Link>
      <Link href="/settings" className={active === "settings" ? "active" : ""}>
        Settings
      </Link>
    </nav>
  );
}
