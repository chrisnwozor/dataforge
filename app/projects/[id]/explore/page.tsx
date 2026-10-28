import { PageHeader } from "@/components/shared";
import { ExploreWorkspace } from "@/components/explore-workspace";
import { getSemanticModel } from "@/lib/server/semantic";
import { HttpError } from "@/lib/server/http";
import type { SemanticModel } from "@/lib/semantic/types";

export const metadata = { title: "Explore" };

export default async function ExplorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let initialModel: SemanticModel | null = null;
  let initialError = "";
  try { initialModel = await getSemanticModel(id); }
  catch (error) { initialError = error instanceof HttpError ? error.message : "The semantic fields could not be loaded. Try again."; }
  return <main className="container"><PageHeader eyebrow="FROM MEASURES TO ANSWERS" title="Explore your data" description="Arrange your fields, find a pattern, and save a view worth coming back to." /><ExploreWorkspace key={id} projectId={id} initialModel={initialModel} initialError={initialError} /></main>;
}
