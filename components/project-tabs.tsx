"use client";
import { IntentLink as Link } from "./intent-link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListFilter,
  Workflow,
  Terminal,
  History,
} from "lucide-react";
const tabs = [
  { label: "Overview", path: "", Icon: LayoutDashboard },
  { label: "Profile", path: "/profile", Icon: ListFilter },
  { label: "Model", path: "/model", Icon: Workflow },
  { label: "Generate", path: "/generate", Icon: Terminal },
  { label: "Runs", path: "/runs", Icon: History },
];
export function ProjectTabs({ id }: { id: string }) {
  const pathname = usePathname();
  return (
    <nav className="top-tabs" aria-label="Project navigation">
      {tabs.map(({ label, path, Icon }) => (
        <Link
          key={label}
          href={`/projects/${id}${path}`}
          className={pathname === `/projects/${id}${path}` ? "active" : ""}
        >
          <Icon size={13} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
