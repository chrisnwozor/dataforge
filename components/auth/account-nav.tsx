"use client";
import Link from "next/link";
import {
  useIdentity,
  useWorkspaceRole,
  canAdmin,
  accountRequest,
  navigateFresh,
} from "./provider";
import styles from "./auth.module.css";
export function AccountNav() {
  const identity = useIdentity(),
    role = useWorkspaceRole();
  if (!identity.user)
    return (
      <Link href="/sign-in" className="docs-link">
        Sign in
      </Link>
    );
  return (
    <div className={styles.navLinks}>
      {canAdmin(role) && <Link href="/settings">Settings</Link>}
      {canAdmin(role) && <Link href="/activity">Activity</Link>}
      <Link
        href="/account"
        className={`avatar ${styles.accountAvatar}`}
        aria-label="Account settings"
      >
        {identity.user.name[0]?.toUpperCase() || "A"}
      </Link>
      {!identity.local && (
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() =>
            void accountRequest("/api/auth/sign-out").then(() =>
              navigateFresh("/sign-in"),
            )
          }
        >
          Sign out
        </button>
      )}
    </div>
  );
}
