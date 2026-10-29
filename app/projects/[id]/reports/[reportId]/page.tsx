import { withProjectPage } from "@/lib/auth/guards";
import { ReportEditor } from "@/components/reports/report-editor";
export const metadata = { title: "Report" };
async function ReportPage({ params }: { params: Promise<{ id: string; reportId: string }> }) {
  const { id, reportId } = await params;
  return <main className="container"><ReportEditor key={`${id}:${reportId}`} projectId={id} reportId={reportId} /></main>;
}

export default withProjectPage("viewer", ReportPage);
