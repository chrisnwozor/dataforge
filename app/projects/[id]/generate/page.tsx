import { PageHeader } from "@/components/shared";
import { GenerationWorkspace } from "@/components/generation-workspace";
import { getGeneration } from "@/lib/server/generation";
import { readPublicConnection } from "@/lib/server/connection";
import { findActiveRun } from "@/lib/server/runs";
export const metadata = { title: "Generate SQL" };
export default async function GeneratePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const connection = readPublicConnection();
  const generation = await getGeneration(
    id,
    connection.configured ? { db: connection.database } : {},
  );
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
