import { withWorkspacePage } from "@/lib/auth/guards";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/shared";
import { NewProjectForm } from "@/components/new-project-form";
export const metadata = { title: "New project" };
function NewProjectPage() {
  return (
    <main className="wizard-container">
      <Link href="/projects" className="back-link">
        <ArrowLeft size={13} />
        Back to projects
      </Link>
      <PageHeader
        eyebrow="A FRESH START"
        title="Create a project"
        description="A file today. A foundation for your data tomorrow."
      />
      <NewProjectForm />
    </main>
  );
}

export default withWorkspacePage("editor", NewProjectPage);
