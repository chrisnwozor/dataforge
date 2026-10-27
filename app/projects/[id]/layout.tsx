import { notFound } from "next/navigation";
import { getProject, getProjects } from "@/lib/data";
import { ProjectTabs } from "@/components/project-tabs";
export async function generateStaticParams() {
  return [
    ...(await getProjects()).map((p) => ({ id: p.id })),
    { id: "new-project" },
  ];
}
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
