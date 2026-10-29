import { withProjectPage } from "@/lib/auth/guards";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/shared";
import { buttonVariants } from "@/components/ui/button";
import { SourceManager } from "@/components/sources/source-manager";

export const metadata = { title: "Project sources" };
async function SourcesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><PageHeader eyebrow="BUILD YOUR INPUTS" title="Sources" description="Add files, check their columns, and connect them in Prepare." actions={<Link href={`/projects/${id}/prepare`} className={buttonVariants({ variant: "outline" })}>Open Prepare<ArrowRight size={13} aria-hidden="true" /></Link>} /><SourceManager key={id} projectId={id} /></main>;
}

export default withProjectPage("editor", SourcesPage);
