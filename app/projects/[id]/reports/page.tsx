import { withProjectPage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { ReportList } from "@/components/reports/report-list";
export const metadata = { title: "Reports" };
async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><PageHeader eyebrow="READY TO SHARE" title="Reports" description="Design paginated reports, export your results, and schedule the next edition." /><ReportList projectId={id} /></main>;
}

export default withProjectPage("viewer", ReportsPage);
