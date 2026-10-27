import { PageHeader } from "@/components/shared";
import { ModelEditor } from "@/components/model-editor";
import { getColumnProfiles } from "@/lib/data";
import { getOrCreateModel } from "@/lib/server/models";
export const metadata = { title: "Model editor" };
export default async function ModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Legacy profiles are enriched before loading source columns for the editor.
  const saved = await getOrCreateModel(id);
  const columns = await getColumnProfiles(id);
  return (
    <main className="container">
      <PageHeader
        eyebrow="A LITTLE STRUCTURE. A LOT OF POSSIBILITY."
        title="Shape your model"
        description="Turn columns into a star schema. Start with a suggestion, make it your own."
      />
      <ModelEditor
        key={id}
        initialModel={saved.model}
        initialSource={saved.source}
        columns={columns}
        projectId={id}
      />
    </main>
  );
}
