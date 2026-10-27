"use client";
import { useState } from "react";
import { IntentLink as Link } from "./intent-link";
import {
  Search,
  Plus,
  LayoutGrid,
  List,
  ArrowUpRight,
  FileSpreadsheet,
  Database,
  Clock3,
  ArrowRight,
  SlidersHorizontal,
} from "lucide-react";
import type { Project } from "@/lib/types";
import { number } from "@/lib/utils";
import { StatusBadge, DataTable, EmptyState } from "./shared";
import { Button } from "./ui/button";
import { SelectMenu } from "./select-menu";
function Sparkline({ values }: { values: number[] }) {
  if (!values.length)
    return (
      <div
        className="project-spark"
        style={{ display: "flex", alignItems: "center", gap: 4 }}
      >
        {Array.from({ length: 34 }, (_, i) => (
          <div
            key={i}
            style={{ height: 2, flex: 1, background: "var(--line)" }}
          />
        ))}
      </div>
    );
  return (
    <svg
      className="project-spark"
      viewBox="0 0 300 50"
      preserveAspectRatio="none"
      aria-label="Illustrative row load activity"
    >
      <path
        d={`M0 48 H300`}
        fill="none"
        stroke="var(--line)"
        strokeDasharray="3 5"
      />
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * 12.7}
          y={49 - v * 0.43}
          width="7"
          height={v * 0.43}
          rx="1"
          fill={i > 18 ? "var(--muted)" : "var(--line-strong)"}
        />
      ))}
    </svg>
  );
}
export function ProjectsList({ projects }: { projects: Project[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState("recent");
  const filtered = projects
    .filter(
      (p) =>
        `${p.name} ${p.sourceName}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (status === "All statuses" || p.status === status),
    )
    .toSorted((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : sort === "rows"
          ? b.rows - a.rows
          : 0,
    );
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <label className="search-field">
            <Search size={14} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
            />
          </label>
          <SelectMenu
            label="Filter by status"
            value={status}
            onValueChange={setStatus}
            options={["All statuses", "Ready", "Needs review", "Draft"].map(
              (value) => ({ value, label: value }),
            )}
            style={{ fontSize: 11, height: 36, maxWidth: 135 }}
          />
        </div>
        <div className="toolbar-right">
          <span className="muted small">Sort by</span>
          <SelectMenu
            id="project-sort"
            label="Sort by"
            value={sort}
            onValueChange={setSort}
            align="end"
            style={{
              fontSize: 11,
              height: 34,
              border: 0,
              background: "transparent",
            }}
            options={[
              { value: "recent", label: "Last updated" },
              { value: "name", label: "Name" },
              { value: "rows", label: "Row count" },
            ]}
          />
          <div className="layout-controls">
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <LayoutGrid size={14} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={14} />
            </button>
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          title="No projects found"
          description="Try a different name or status to find your project."
        />
      ) : view === "grid" ? (
        <div className="projects-grid">
          {filtered.map((p) => (
            <article className="project-card" key={p.id}>
              <Link href={`/projects/${p.id}`} className="project-card-main">
                <div className="project-card-top">
                  <span className="project-icon">
                    <Database size={17} />
                  </span>
                  <StatusBadge status={p.status} />
                </div>
                <h2 className="project-name">
                  {p.name}
                  <ArrowUpRight size={12} className="muted" />
                </h2>
                <div className="project-source">
                  <FileSpreadsheet size={11} />
                  <span>{p.sourceName}</span>
                  <span>· {p.sourceType}</span>
                </div>
                <Sparkline values={p.activity} />
                <div className="project-card-metrics">
                  <span>
                    <strong className="mono">{number(p.rows)}</strong> rows
                  </span>
                  <span>
                    <strong className="mono">{p.columns}</strong> columns
                  </span>
                  <span>
                    <strong className="mono">{p.tables}</strong> tables
                  </span>
                </div>
              </Link>
              <div className="project-card-footer">
                <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <Clock3 size={11} />
                  Updated {p.updatedAt}
                </span>
                <Link
                  href={`/projects/${p.id}/runs`}
                  aria-label={`View runs for ${p.name}`}
                >
                  <ArrowRight size={13} />
                </Link>
              </div>
            </article>
          ))}
          <Link href="/projects/new" className="new-project-card">
            <span className="project-icon">
              <Plus size={18} />
            </span>
            <span>Create a new project</span>
            <p>Every great model starts with a file.</p>
          </Link>
        </div>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Project</th>
              <th>Source</th>
              <th>Status</th>
              <th>Last run</th>
              <th>Rows</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link
                    href={`/projects/${p.id}`}
                    className="project-name"
                    style={{ fontSize: 12 }}
                  >
                    <Database size={14} />
                    {p.name}
                  </Link>
                </td>
                <td className="muted">{p.sourceType}</td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td className="muted">{p.lastRun}</td>
                <td className="mono">{number(p.rows)}</td>
                <td>
                  <Link
                    href={`/projects/${p.id}`}
                    aria-label={`Open ${p.name}`}
                  >
                    <ArrowUpRight size={14} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <div className="table-foot">
        <span>
          {filtered.length} of {projects.length} projects
        </span>
        <span>All activity shown is sample data.</span>
      </div>
      <div className="info-banner">
        <SlidersHorizontal size={16} />
        <span>
          <strong>A little structure goes a long way.</strong> Turn your next
          spreadsheet into a warehouse-ready model.
        </span>
        <Link href="/projects/new">
          Start a project <ArrowRight size={13} />
        </Link>
      </div>
      {(search || status !== "All statuses") && filtered.length === 0 && (
        <Button
          variant="outline"
          onClick={() => {
            setSearch("");
            setStatus("All statuses");
          }}
        >
          Clear filters
        </Button>
      )}
    </>
  );
}
