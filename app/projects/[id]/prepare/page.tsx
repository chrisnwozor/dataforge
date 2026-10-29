import { PrepareEditor } from "@/components/prepare/prepare-editor";

export const metadata = { title: "Prepare" };
export default async function PreparePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="container"><PrepareEditor key={id} projectId={id} /></main>;
}
