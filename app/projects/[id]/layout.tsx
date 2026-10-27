import { notFound } from "next/navigation";
import { getProject } from "@/lib/data";
import { ProjectTabs } from "@/components/project-tabs";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!(await getProject(id))) notFound();
  return (
    <>
      <ProjectTabs id={id} />
      {children}
    </>
  );
}
