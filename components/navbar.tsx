import { IntentLink as Link } from "./intent-link";
import { Command, Layers2, ArrowUpRight } from "lucide-react";
import { WorkspaceSwitcher } from "./project-switcher";
import { ThemeToggle } from "./theme-provider";
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="DataForge home">
      <span className="brand-icon">
        <Layers2 size={21} strokeWidth={2.2} />
      </span>
      <span>
        DataForge<span className="brand-period">.</span>
      </span>
    </Link>
  );
}
export function Navbar() {
  return (
    <header className="navbar">
      <div className="nav-left">
        <Brand />
        <span className="nav-slash">/</span>
        <WorkspaceSwitcher />
      </div>
      <div className="nav-right">
        <a
          href="https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql"
          target="_blank"
          rel="noreferrer"
          className="docs-link"
        >
          SQL reference <ArrowUpRight size={12} />
        </a>
        <span className="nav-divider" />
        <ThemeToggle />
        <Link href="/settings" className="avatar" aria-label="Account settings">
          A
        </Link>
      </div>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="footer">
      <span>
        <span className="status-dot success" />
        All systems operational
      </span>
      <span>
        Built for the way you work.
        <span className="footer-shortcut">
          <Command size={11} /> DataForge
        </span>
      </span>
    </footer>
  );
}
