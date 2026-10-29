import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  FileSpreadsheet,
  Columns3,
  Copy,
  CircleDashed,
  Check,
  Upload,
  Workflow,
  ScanLine,
  History,
} from "lucide-react";
import { getProject, getActivity } from "@/lib/data";
import {
  PageHeader,
  StatCard,
  StatusBadge,
} from "@/components/shared";
import { PreparationStepper, PrepareQuality } from "@/components/prepare-quality";
import { buttonVariants } from "@/components/ui/button";
import { number } from "@/lib/utils";
import { readPublicConnection } from "@/lib/server/connection";
import { readPipeline } from "@/lib/server/prepare-storage";
export const metadata = { title: "Project overview" };
export default async function Overview({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, activity] = await Promise.all([
    getProject(id),
    getActivity(id),
  ]);
  if (!project) notFound();
  const connection = readPublicConnection();
  const preparation = readPipeline(id);
  const needsPreparation = !!preparation && (preparation.status === "queued" || preparation.status === "running" || preparation.profiledVersion !== preparation.version);
  const next =
    needsPreparation
      ? "prepare"
      : project.stage < 2
      ? "profile"
      : project.stage === 2
        ? "model"
        : project.stage >= 4
          ? "runs"
          : "generate";
  return (
    <main className="container">
      <Link href="/projects" className="back-link" style={{ marginBottom: 20 }}>
        <ArrowLeft size={12} />
        All projects
      </Link>
      <PageHeader
        title={project.name}
        description={project.description}
        actions={
          <>
            <StatusBadge status={project.status} />
            <Link
              href={`/projects/${id}/${next}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Open {next}
              <ArrowRight size={14} />
            </Link>
          </>
        }
      />
      <div className="stats-grid">
        <StatCard
          label="Total rows"
          value={number(project.rows)}
          detail="Rows in the current prepared profile"
          icon={<FileSpreadsheet size={14} />}
        />
        <StatCard
          label="Columns"
          value={String(project.columns)}
          detail="Columns in the prepared profile"
          icon={<Columns3 size={14} />}
        />
        <StatCard
          label="Fully duplicated rows"
          value={
            project.duplicateRows == null ? "—" : number(project.duplicateRows)
          }
          detail="Extra occurrences of identical prepared rows"
          icon={<Copy size={14} />}
        />
        <StatCard
          label="Total null cells"
          value={
            project.totalNullCells == null
              ? "—"
              : number(project.totalNullCells)
          }
          detail="Blank or missing values across all columns"
          icon={<CircleDashed size={14} />}
        />
      </div>
      <section className="panel">
        <div className="panel-header">
          <h2>Your data pipeline</h2>
          <span className="small muted">
            {needsPreparation
              ? "Finish preparation before continuing"
              : project.stage === 5
              ? "Ready to run again"
              : project.stage === 4
                ? "Run in progress or ready to review"
                : "Next up: " +
                  ["upload", "profile", "model", "generate", "run"][
                    project.stage
                  ]}
          </span>
        </div>
        <div className="panel-body">
          <PreparationStepper projectId={id} stage={project.stage} />
        </div>
      </section>
      <PrepareQuality projectId={id} />
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>Recent activity</h2>
            <Link
              href={`/projects/${id}/runs`}
              className="small muted"
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
              View runs <ArrowRight size={12} />
            </Link>
          </div>
          <div
            className="panel-body"
            style={{ paddingTop: 0, paddingBottom: 0 }}
          >
            {activity.map((a) => {
              const Icon = {
                run: Check,
                upload: Upload,
                model: Workflow,
                profile: ScanLine,
              }[a.kind];
              return (
                <div className="activity-row" key={a.id ?? a.kind}>
                  <span className="activity-symbol">
                    <Icon size={12} />
                  </span>
                  <div>
                    <p>{a.title}</p>
                    <small>{a.description}</small>
                  </div>
                  <time>{a.time}</time>
                </div>
              );
            })}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header">
            <h2>Project details</h2>
            <FileSpreadsheet size={14} className="muted" />
          </div>
          <div
            className="panel-body"
            style={{ paddingTop: 8, paddingBottom: 8 }}
          >
            {[
              ["Source file", project.sourceName],
              ["Source type", project.sourceType],
              [
                "Target",
                connection.configured
                  ? `${connection.server}:${connection.port} / ${connection.database}`
                  : "Configure in Settings",
              ],
              ["Schemas", "stg · dw · etl"],
              ["Environment", "Local workspace"],
            ].map(([label, value]) => (
              <div className="detail-row" key={label}>
                <span>{label}</span>
                <span
                  className={
                    label === "Source file" || label === "Default schema"
                      ? "mono"
                      : ""
                  }
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="info-banner">
        <History size={15} />
        <span>
          Sources and preparation produce the dataset used by profiling, modeling,
          and SQL execution. Run history records actual loads and rejected rows.
        </span>
        <Link href={`/projects/${id}/runs`}>
          View run history <ArrowRight size={12} />
        </Link>
      </div>
    </main>
  );
}
