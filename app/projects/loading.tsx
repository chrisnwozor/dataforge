export default function Loading() {
  return (
    <main className="container" aria-busy="true" aria-label="Loading projects">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton-grid">
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton skeleton-card" key={i} />
        ))}
      </div>
      <div className="skeleton skeleton-table" />
    </main>
  );
}
