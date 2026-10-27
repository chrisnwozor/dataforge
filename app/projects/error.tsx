"use client";
import { Button } from "@/components/ui/button";
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="container">
      <div className="error-box" role="alert">
        <h1>We couldn’t load this project.</h1>
        <p className="muted">Try again to get back to your data.</p>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
