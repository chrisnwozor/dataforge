import Link from "next/link";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { getColumnProfiles, getProfileReport } from "@/lib/data";
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
  const [columns, report] = await Promise.all([
    getColumnProfiles(id),
    getProfileReport(id),
  ]);
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
      {report.raggedRowCount > 0 && (
        <div
          className="info-banner"
          role="status"
          style={{ margin: "0 0 22px" }}
        >
          <TriangleAlert size={16} style={{ color: "var(--amber)" }} />
          <span>
            <strong>
              {report.raggedRowCount.toLocaleString("en-US")} rows have a
              different number of fields.
            </strong>{" "}
            They are included in the profile; missing fields count as empty and
            extra fields are ignored.{" "}
            {report.raggedRowExamples.length > 0 &&
              `Examples: ${report.raggedRowExamples.map((row) => `row ${row.row} (${row.actual} fields, expected ${row.expected})`).join("; ")}.`}
          </span>
        </div>
      )}
      <ProfileTable key={id} columns={columns} projectId={id} />
    </main>
  );
}
