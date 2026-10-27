import {
  Check,
  ChevronRight,
  ArrowUpRight,
  Database,
  Inbox,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const kind = ["Ready", "Success", "Completed"].includes(status)
    ? "success"
    : ["Failed", "Error"].includes(status)
      ? "error"
      : ["Draft", "Needs review"].includes(status)
        ? "warning"
        : "info";
  return (
    <span className={cn("status-badge", kind)}>
      <span className={cn("status-dot", kind)} />
      {status}
    </span>
  );
}
export function StatCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="stat-card">
      <div className="stat-label">
        {label}
        {icon || <Database size={15} />}
      </div>
      <div className="stat-value mono">{value}</div>
      <div className="stat-detail">{detail}</div>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  href,
  label,
}: {
  title: string;
  description: string;
  href?: string;
  label?: string;
}) {
  return (
    <div className="empty-state">
      <Inbox size={28} />
      <h2>{title}</h2>
      <p>{description}</p>
      {href && (
        <Link className="button button-primary" href={href}>
          {label}
          <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
export function DataTable({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="group"
      aria-label="Data table"
    >
      <table className="data-table">{children}</table>
    </div>
  );
}
export function PipelineStepper({ current = 2 }: { current?: number }) {
  return (
    <div
      className="pipeline"
      tabIndex={0}
      role="region"
      aria-label="Pipeline progress"
    >
      {["Upload", "Profile", "Model", "Generate", "Run"].map((label, i) => (
        <div
          key={label}
          className={cn(
            "pipeline-stage",
            i < current && "complete",
            i === current && "current",
          )}
        >
          <span className="step-circle">
            {i < current ? <Check size={15} /> : i + 1}
          </span>
          <span>{label}</span>
          {i < 4 && <ChevronRight size={14} className="step-arrow" />}
        </div>
      ))}
    </div>
  );
}
