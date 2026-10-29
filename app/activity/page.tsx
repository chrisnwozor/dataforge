import { withWorkspacePage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { ActivityPanel } from "@/components/auth/activity-panel";
function Page() {
  return (
    <main className="container">
      <PageHeader
        eyebrow="WORKSPACE HISTORY"
        title="Activity"
        description="A record of access, administration and data operations in this workspace."
      />
      <ActivityPanel />
    </main>
  );
}
export const metadata = { title: "Activity" };
export default withWorkspacePage("admin", Page);
