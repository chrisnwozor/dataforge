"use client";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
export function ProjectSwitcher({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const path = usePathname();
  const router = useRouter();
  const id = path.split("/")[2];
  const selected = projects.some((p) => p.id === id) ? id : "";
  return (
    <div className="workspace-switch">
      <span className="workspace-avatar" aria-hidden="true">
        AC
      </span>
      <select
        aria-label="Switch project"
        value={selected}
        onChange={(e) =>
          router.push(
            e.target.value ? `/projects/${e.target.value}` : "/projects",
          )
        }
      >
        <option value="">Acme workspace</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <span className="plan-badge">Hobby</span>
      <ChevronDown size={13} aria-hidden="true" />
    </div>
  );
}
