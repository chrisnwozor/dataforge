import { PageHeader } from "@/components/shared";
import { WorkspaceTabs } from "@/components/workspace-tabs";
import { SettingsForm } from "@/components/settings-form";
import { readPublicConnection } from "@/lib/server/connection";
export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function SettingsPage() {
  const connection = readPublicConnection();
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
          <SettingsForm initialConnection={connection} />
        </div>
      </main>
    </>
  );
}
