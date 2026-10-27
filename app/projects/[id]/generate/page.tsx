import { PageHeader } from "@/components/shared";
import { CodeViewer } from "@/components/code-viewer";
import { GenerateControls } from "@/components/generate-controls";
import { getGeneratedFiles } from "@/lib/data";
export const metadata = { title: "Generate SQL" };
export default async function GeneratePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="container">
      <PageHeader
        eyebrow="FROM MODEL TO WAREHOUSE"
        title="Your SQL, ready to review"
        description="Readable scripts. A predictable structure. No black box."
      />
      <div className="code-layout">
        <CodeViewer files={await getGeneratedFiles(id)} />
        <GenerateControls projectId={id} />
      </div>
    </main>
  );
}
