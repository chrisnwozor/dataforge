import { withProjectPage } from "@/lib/auth/guards";
import { PageHeader } from "@/components/shared";
import { GenerationWorkspace } from "@/components/generation-workspace";
import { getGeneration } from "@/lib/server/generation";
import { readExecutionTarget } from "@/lib/server/connection";
import { findActiveRun } from "@/lib/server/runs";
import { HttpError } from "@/lib/server/http";
import { hasStoredPipeline } from "@/lib/server/prepare-storage";
import { PreparationUnavailable } from "@/components/preparation-unavailable";
export const metadata = { title: "Generate SQL" };
async function GeneratePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const connection = readExecutionTarget();
  let generation;
  try { generation = await getGeneration(id, connection.configured ? { db: connection.database } : {}); }
  catch (error) {
    if (error instanceof HttpError && hasStoredPipeline(id) && [409, 422].includes(error.status)) return <PreparationUnavailable projectId={id} title="Prepare your data before generating SQL" message={error.message} />;
    throw error;
  }
  return (
    <main className="container">
      <PageHeader
        eyebrow="FROM MODEL TO WAREHOUSE"
        title="Your SQL, ready to review"
        description="Readable scripts. A predictable structure. No black box."
      />
      <GenerationWorkspace
        key={id}
        projectId={id}
        initialGeneration={generation}
        initialConnection={connection}
        initialActiveRun={findActiveRun(id) ?? null}
      />
    </main>
  );
}

export default withProjectPage("editor", GeneratePage);
