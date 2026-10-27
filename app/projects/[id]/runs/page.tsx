import Link from "next/link";
import { Terminal } from "lucide-react";
import { getRuns } from "@/lib/data";
import { PageHeader } from "@/components/shared";
import { RunsTable } from "@/components/runs-table";
import { buttonVariants } from "@/components/ui/button";
export const metadata = { title: "Run history" };
export default async function RunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="container">
      <PageHeader
        eyebrow="EVERY LOAD, ACCOUNTED FOR"
        title="Run history"
        description="A clear record of what made it into your warehouse."
        actions={
          <Link
            href={`/projects/${id}/generate`}
            className={buttonVariants({ variant: "outline" })}
          >
            <Terminal size={14} />
            Generate SQL
          </Link>
        }
      />
      <RunsTable runs={await getRuns(id)} />
    </main>
  );
}
