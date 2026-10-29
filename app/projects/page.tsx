import { currentWorkspaceId, requireWorkspaceRole } from "@/lib/auth/context";
import { withWorkspacePage } from "@/lib/auth/guards";
import Link from "next/link";
import { Plus } from "lucide-react";
import { getProjects } from "@/lib/data";
import { PageHeader } from "@/components/shared";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { ProjectsList } from "@/components/projects-list";
import { buttonVariants } from "@/components/ui/button";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const metadata = { title: "Projects" };
async function ProjectsPage() {
  const projects = await getProjects();
  const canEdit = requireWorkspaceRole(currentWorkspaceId()).role !== "viewer";
  return (
    <>
      <WorkspaceTabs count={projects.length} />
      <main className="container">
        <PageHeader
          eyebrow="YOUR WORKSPACE"
          title="Projects"
          description="Your data. A little more organized."
          actions={canEdit ?
            <Link href="/projects/new" className={buttonVariants()}>
              <Plus size={15} />
              New project
            </Link> : undefined
          }
        />
        <ProjectsList projects={projects} />
      </main>
    </>
  );
}

export default withWorkspacePage("viewer", ProjectsPage);
