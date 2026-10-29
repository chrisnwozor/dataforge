import { withUserPage } from "@/lib/auth/guards";
import { WorkspacesPanel } from "@/components/auth/workspaces-panel";
import { PageHeader } from "@/components/shared";
function Page() {
  return (
    <main className="container">
      <PageHeader
        eyebrow="YOUR TEAM’S SPACE"
        title="Workspaces"
        description="Keep projects separate, invite your team, and give everyone the right access."
      />
      <WorkspacesPanel />
    </main>
  );
}
export const metadata = { title: "Workspaces" };
export default withUserPage(Page);
