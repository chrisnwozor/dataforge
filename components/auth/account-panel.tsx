"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  navigateFresh,
  accountRequest,
  useIdentity,
  useWorkspaceRole,
  canAdmin,
} from "./provider";
import styles from "./auth.module.css";
interface Account {
  user: { name: string; email: string; emailVerifiedAt: string | null };
  local: boolean;
  sessions: {
    id: string;
    ip: string;
    userAgent: string;
    createdAt: string;
    expiresAt: string;
    current: boolean;
  }[];
}
export function AccountPanel() {
  const role = useWorkspaceRole();
  const identity = useIdentity(),
    [account, setAccount] = useState<Account | null>(null),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState(false);
  async function load() {
    try {
      setAccount(await accountRequest("/api/account", "GET"));
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    let active = true;
    void accountRequest("/api/account", "GET")
      .then((d) => {
        if (active) setAccount(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function execute(
    path: string,
    method: string,
    body?: unknown,
    leave = false,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await accountRequest(path, method, body);
      if (leave) {
        navigateFresh("/sign-in");
        return;
      }
      await identity.refresh();
      await load();
      setMessage(result.message || "Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function profile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void execute(
      "/api/account",
      "PUT",
      Object.fromEntries(new FormData(e.currentTarget)),
    );
  }
  if (!account) return <p role="status">{error || "Loading account…"}</p>;
  return (
    <div className={styles.compact}>
      <div className={styles.status}>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className={styles.success} role="status">
            {message}
          </p>
        )}
      </div>
      <nav
        aria-label="Account shortcuts"
        className={styles.links}
        style={{ margin: "0 0 20px" }}
      >
        <Link href="/projects">Projects</Link>
        <Link href="/workspaces">Workspaces</Link>
        {canAdmin(role) && (
          <>
            <Link href="/settings">Connections</Link>
            <Link href="/activity">Activity</Link>
          </>
        )}
      </nav>
      {account.local && (
        <p className={styles.muted}>
          Local mode is enabled. Set DATAFORGE_AUTH=on to use accounts,
          invitations and multiple workspaces.
        </p>
      )}
      <section className={styles.section}>
        <h2>Profile</h2>
        <p className={styles.muted}>
          {account.user.email} ·{" "}
          {account.user.emailVerifiedAt ? "Verified" : "Verification needed"}
        </p>
        <form className={styles.form} onSubmit={profile}>
          <label>
            Name
            <input
              className="input"
              key={account.user.name}
              name="name"
              defaultValue={account.user.name}
              maxLength={100}
              required
            />
          </label>
          <div>
            <Button disabled={busy || account.local}>Save profile</Button>
          </div>
        </form>
      </section>
      {!account.local && (
        <>
          <section className={styles.section}>
            <h2>Password</h2>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                void execute(
                  "/api/auth/change-password",
                  "POST",
                  Object.fromEntries(new FormData(e.currentTarget)),
                  true,
                );
              }}
            >
              <label>
                Current password
                <input
                  className="input"
                  type="password"
                  name="currentPassword"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                />
              </label>
              <label>
                New password
                <input
                  className="input"
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={1024}
                  required
                />
              </label>
              <div>
                <Button disabled={busy} variant="outline">
                  Change password and sign out everywhere
                </Button>
              </div>
            </form>
          </section>
          <section className={styles.section}>
            <h2>Sessions</h2>
            <p className={styles.muted}>
              Sessions expire after 14 days without activity.
            </p>
            <ul className={styles.list}>
              {account.sessions.map((s) => (
                <li key={s.id}>
                  <div className={styles.details}>
                    <strong>
                      {s.current ? "This device" : "Other device"}
                    </strong>
                    <small>
                      {s.userAgent || "Unknown browser"} · {s.ip}
                    </small>
                    <small>
                      Signed in {new Date(s.createdAt).toLocaleString()}
                    </small>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void execute(
                        `/api/account/sessions/${s.id}`,
                        "DELETE",
                        undefined,
                        s.current,
                      )
                    }
                  >
                    Sign out{!s.current ? " device" : ""}
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void execute(
                  "/api/auth/sign-out-everywhere",
                  "POST",
                  undefined,
                  true,
                )
              }
            >
              Sign out everywhere
            </Button>
          </section>
          <section className={`${styles.section} ${styles.danger}`}>
            <h2>Delete account</h2>
            <p className={styles.muted}>
              Transfer ownership of shared workspaces first. Workspaces where
              you are the only member can be deleted with your account.
            </p>
            {!deleting ? (
              <Button variant="outline" onClick={() => setDeleting(true)}>
                Delete my account…
              </Button>
            ) : (
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  void execute(
                    "/api/account",
                    "DELETE",
                    {
                      password: d.get("password"),
                      deleteSoleOwnedWorkspaces:
                        d.get("deleteSoleOwnedWorkspaces") === "on",
                    },
                    true,
                  );
                }}
              >
                <label>
                  Confirm your password
                  <input
                    className="input"
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label className={styles.row}>
                  <input type="checkbox" name="deleteSoleOwnedWorkspaces" />{" "}
                  Also delete workspaces where I am the only member
                </label>
                <div className={styles.row}>
                  <Button disabled={busy}>Permanently delete account</Button>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setDeleting(false)}
                  >
                    Keep account
                  </Button>
                </div>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}
