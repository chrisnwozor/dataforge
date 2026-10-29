import { withProjectPage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { MeasuresWorkspace } from "@/components/measures-workspace";

export const metadata = { title: "Measures" };

async function MeasuresPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="container">
      <PageHeader
        eyebrow="A SHARED LANGUAGE FOR YOUR DATA"
        title="Make every measure count"
        description="Define measures, follow hierarchies, and ask a first question of your warehouse."
      />
      <MeasuresWorkspace key={id} projectId={id} />
    </main>
  );
}

export default withProjectPage("editor", MeasuresPage);
