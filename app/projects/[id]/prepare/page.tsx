import { withProjectPage } from "@/lib/auth/guards";
import { PrepareEditor } from "@/components/prepare/prepare-editor";

export const metadata = { title: "Prepare" };
async function PreparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><PrepareEditor key={id} projectId={id} /></main>;
}

export default withProjectPage("editor", PreparePage);
