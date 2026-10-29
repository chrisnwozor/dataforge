"use client";
import { IntentLink as Link } from "./intent-link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListFilter,
  Workflow,
  Terminal,
  History,
  Sigma,
  ChartNoAxesCombined,
  PanelsTopLeft,
  FileBarChart2,
  Files,
  GitBranch,
} from "lucide-react";
const tabs = [
  { label: "Overview", path: "", Icon: LayoutDashboard },
  { label: "Sources", path: "/sources", Icon: Files },
  { label: "Prepare", path: "/prepare", Icon: GitBranch },
  { label: "Profile", path: "/profile", Icon: ListFilter },
  { label: "Model", path: "/model", Icon: Workflow },
  { label: "Measures", path: "/measures", Icon: Sigma },
  { label: "Explore", path: "/explore", Icon: ChartNoAxesCombined },
  { label: "Dashboards", path: "/dashboards", Icon: PanelsTopLeft },
  { label: "Reports", path: "/reports", Icon: FileBarChart2 },
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
          className={(pathname === `/projects/${id}${path}` || (path !== "" && pathname.startsWith(`/projects/${id}${path}/`))) ? "active" : ""}
        >
          <Icon size={13} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
