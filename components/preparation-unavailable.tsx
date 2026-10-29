import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { PageHeader } from "./shared";
import { buttonVariants } from "./ui/button";
import { PrepareQuality } from "./prepare-quality";

/** A preparation failure should leave its repair controls and rejects reachable. */
export function PreparationUnavailable({ projectId, title, message }: { projectId: string; title: string; message: string }) {
  return <main className="container">
    <PageHeader eyebrow="PREPARED DATASET" title={title} description="Finish preparing your data to continue." actions={<Link className={buttonVariants()} href={`/projects/${projectId}/prepare`}>Open Prepare<ArrowRight size={14} aria-hidden="true" /></Link>} />
    <div className="info-banner" role="alert" style={{ marginBottom: 22 }}><TriangleAlert size={16} aria-hidden="true" /><span>{message}</span></div>
    <PrepareQuality projectId={projectId} />
  </main>;
}
