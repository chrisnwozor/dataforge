import { PageHeader } from "@/components/shared";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { SettingsForm } from "@/components/settings-form";
export const metadata = { title: "Settings" };
export default function SettingsPage() {
  return (
    <>
      <WorkspaceTabs active="settings" />
      <main className="container">
        <PageHeader
          eyebrow="YOUR WORKSPACE, YOUR WAY"
          title="Settings"
          description="The small details that keep your warehouse in order."
        />
        <div className="settings-grid">
          <nav className="settings-nav" aria-label="Settings sections">
            <a href="#connection">Connection</a>
            <a href="#schema">Warehouse defaults</a>
            <a href="#appearance">Appearance</a>
          </nav>
          <SettingsForm />
        </div>
      </main>
    </>
  );
}
