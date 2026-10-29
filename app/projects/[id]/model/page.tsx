import { PageHeader } from "@/components/shared";
import { ModelEditor } from "@/components/model-editor";
import { getColumnProfiles } from "@/lib/data";
import { getOrCreateModel } from "@/lib/server/models";
import { HttpError } from "@/lib/server/http";
import { hasStoredPipeline } from "@/lib/server/prepare-storage";
import { PreparationUnavailable } from "@/components/preparation-unavailable";
export const metadata = { title: "Model editor" };
export default async function ModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Legacy profiles are enriched before loading source columns for the editor.
  let saved, columns;
  try { saved = await getOrCreateModel(id); columns = await getColumnProfiles(id); }
  catch (error) {
    if (error instanceof HttpError && hasStoredPipeline(id) && [409, 422].includes(error.status)) return <PreparationUnavailable projectId={id} title="Prepare your data before modeling" message={error.message} />;
    throw error;
  }
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
