import { PageHeader } from "@/components/shared";
import { ModelEditor } from "@/components/model-editor";
import {
  getInitialModel,
  getSuggestedModel,
  getColumnProfiles,
} from "@/lib/data";
export const metadata = { title: "Model editor" };
export default async function ModelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [initialModel, suggestedModel, columns] = await Promise.all([
    getInitialModel(id),
    getSuggestedModel(id),
    getColumnProfiles(id),
  ]);
  return (
    <main className="container">
      <PageHeader
        eyebrow="A LITTLE STRUCTURE. A LOT OF POSSIBILITY."
        title="Shape your model"
        description="Turn columns into a star schema. Start with a suggestion, make it your own."
      />
      <ModelEditor
        initialModel={initialModel}
        suggestedModel={suggestedModel}
        columns={columns}
        projectId={id}
      />
    </main>
  );
}
