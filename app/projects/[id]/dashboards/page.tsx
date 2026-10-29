import { PageHeader } from "@/components/shared";
import { DashboardList } from "@/components/dashboards/dashboard-list";
export const metadata = { title: "Dashboards" };
export default async function DashboardsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><PageHeader eyebrow="THE BIG PICTURE" title="Dashboards" description="Bring your measures, charts, and notes into a view you can share." /><DashboardList projectId={id} /></main>;
}
