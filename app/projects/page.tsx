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
export default async function ProjectsPage() {
  const projects = await getProjects();
  return (
    <>
      <WorkspaceTabs count={projects.length} />
      <main className="container">
        <PageHeader
          eyebrow="YOUR WORKSPACE"
          title="Projects"
          description="Your data. A little more organized."
          actions={
            <Link href="/projects/new" className={buttonVariants()}>
              <Plus size={15} />
              New project
            </Link>
          }
        />
        <ProjectsList projects={projects} />
      </main>
    </>
  );
}
