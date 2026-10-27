"use client";
import { useSyncExternalStore } from "react";
const subscribe = () => () => {};
export function ProjectIdentity({
  fallback,
  field = "name",
}: {
  fallback: string;
  field?: "name" | "sourceName";
}) {
  const data = useSyncExternalStore(
    subscribe,
    () => sessionStorage.getItem("dataforge-project"),
    () => null,
  );
  let value = fallback;
  if (data) {
    try {
      const project: Record<string, unknown> = JSON.parse(data);
      if (typeof project[field] === "string") value = project[field];
    } catch {
      /* Ignore an invalid local draft. */
    }
  }
  return <>{value}</>;
}
