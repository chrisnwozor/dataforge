import { EmptyState } from "@/components/shared";
export default function NotFound() {
  return (
    <main className="container">
      <EmptyState
        title="This page hasn’t been modeled yet."
        description="The project or page you’re looking for doesn’t exist. Let’s get you back to your workspace."
        href="/projects"
        label="Back to projects"
      />
    </main>
  );
}
