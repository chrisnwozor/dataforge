import Link from "next/link";
export function WorkspaceTabs({ active = "projects" }: { active?: string }) {
  return (
    <nav className="top-tabs" aria-label="Workspace navigation">
      <Link href="/projects" className={active === "projects" ? "active" : ""}>
        Projects <span className="tab-count">5</span>
      </Link>
      <Link href="/settings" className={active === "settings" ? "active" : ""}>
        Settings
      </Link>
    </nav>
  );
}
