import { withProjectPage } from "@/lib/auth/guards";
import { DashboardEditor } from "@/components/dashboards/dashboard-editor";
export const metadata = { title: "Dashboard" };
async function DashboardPage({ params }: { params: Promise<{ id: string; dashboardId: string }> }) {
  const { id, dashboardId } = await params;
  return <main className="container"><DashboardEditor key={`${id}:${dashboardId}`} projectId={id} dashboardId={dashboardId} /></main>;
}

export default withProjectPage("viewer", DashboardPage);
