import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  FileSpreadsheet,
  Columns3,
  Table2,
  Clock3,
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
import { ProjectIdentity } from "@/components/project-identity";
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
        title={
          id === "new-project" ? (
            <ProjectIdentity fallback={project.name} />
          ) : (
            project.name
          )
        }
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
      {id === "new-project" && (
        <div className="info-banner" style={{ margin: "-10px 0 24px" }}>
          <FileSpreadsheet size={16} />
          <span>
            <strong>
              <ProjectIdentity fallback="Untitled project" />
            </strong>{" "}
            · <ProjectIdentity field="sourceName" fallback="Your source file" />
            . This preview uses the Superstore sample; your file has not been
            parsed.
          </span>
        </div>
      )}
      <div className="stats-grid">
        <StatCard
          label="Source rows"
          value={number(project.rows)}
          detail="Rows in the sample dataset"
          icon={<FileSpreadsheet size={14} />}
        />
        <StatCard
          label="Columns"
          value={String(project.columns)}
          detail="Inferred from source"
          icon={<Columns3 size={14} />}
        />
        <StatCard
          label="Warehouse tables"
          value={String(project.tables)}
          detail="Fact and dimension tables"
          icon={<Table2 size={14} />}
        />
        <StatCard
          label="Last run"
          value={project.lastRun === "Not run yet" ? "—" : project.lastRun}
          detail={
            project.lastRun === "Not run yet"
              ? "Your first load is waiting"
              : "Last simulated warehouse load"
          }
          icon={<Clock3 size={14} />}
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
            {(id === "new-project" ? activity.slice(-1) : activity).map((a) => {
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
              ["Environment", "Demo workspace"],
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
          Every step, accounted for. Review the sample load history before you
          generate your next warehouse.
        </span>
        <Link href={`/projects/${id}/runs`}>
          Explore run history <ArrowRight size={12} />
        </Link>
      </div>
    </main>
  );
}
