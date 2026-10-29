import { withProjectPage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { ChecksWorkspace } from "@/components/checks/checks-workspace";
import styles from "@/components/checks/checks.module.css";

export const metadata = { title: "Data checks" };
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
async function ChecksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className={`container ${styles.shell}`}>
      <PageHeader
        eyebrow="CONFIDENCE IN EVERY NUMBER"
        title="Data checks"
        description="Reconcile prepared data, warehouse measures, reports and dashboards with independent calculations."
      />
      <ChecksWorkspace key={id} projectId={id} />
    </main>
  );
}
export default withProjectPage("editor", ChecksPage);
