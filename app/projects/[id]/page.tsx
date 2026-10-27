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
  PipelineStepper,
} from "@/components/shared";
import { buttonVariants } from "@/components/ui/button";
import { number } from "@/lib/utils";
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
  const next =
    project.stage < 2 ? "profile" : project.stage === 2 ? "model" : "generate";
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
          detail="Rows in the uploaded dataset"
          icon={<FileSpreadsheet size={14} />}
        />
        <StatCard
          label="Columns"
          value={String(project.columns)}
          detail="Inferred from source"
          icon={<Columns3 size={14} />}
        />
        <StatCard
          label="Fully duplicated rows"
          value={
            project.duplicateRows == null ? "—" : number(project.duplicateRows)
          }
          detail="Extra occurrences of identical source rows"
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
            {project.stage === 4
              ? "Ready to run again"
              : "Next up: " +
                ["upload", "profile", "model", "generate", "run"][
                  project.stage
                ]}
          </span>
        </div>
        <div className="panel-body">
          <PipelineStepper current={project.stage} />
        </div>
      </section>
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
                <div className="activity-row" key={a.kind}>
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
              ["Target", "SQL Server 2022"],
              ["Default schema", "warehouse"],
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
          Upload, profiling, modeling, and SQL generation use your source file.
          Run history remains a preview for now.
        </span>
        <Link href={`/projects/${id}/runs`}>
          Explore run history <ArrowRight size={12} />
        </Link>
      </div>
    </main>
  );
}
