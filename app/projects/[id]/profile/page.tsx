import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getColumnProfiles } from "@/lib/data";
import { PageHeader } from "@/components/shared";
import { ProfileTable } from "@/components/profile-table";
import { buttonVariants } from "@/components/ui/button";
export const metadata = { title: "Data profile" };
export default async function ProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const columns = await getColumnProfiles(id);
  return (
    <main className="container">
      <PageHeader
        eyebrow="UNDERSTAND YOUR SOURCE"
        title="Data profile"
        description="Meet your columns. Find the patterns. Catch the outliers."
        actions={
          <Link href={`/projects/${id}/model`} className={buttonVariants()}>
            Review model
            <ArrowRight size={14} />
          </Link>
        }
      />
      <ProfileTable columns={columns} />
    </main>
  );
}
