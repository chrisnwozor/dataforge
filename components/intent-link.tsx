"use client";
import Link from "next/link";
import { useState, type ComponentProps } from "react";
/** Prefetch on keyboard focus or pointer intent, rather than fetching every tab at boot. */
export function IntentLink({
  onMouseEnter,
  onFocus,
  ...props
}: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(event) => {
        setIntent(true);
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        setIntent(true);
        onFocus?.(event);
      }}
    />
  );
}
