"use client";
import { useEffect, useState, type FormEvent } from "react";
import { FormSelect } from "./form-select";
import { Button } from "@/components/ui/button";
import {
  navigateFresh,
  accountRequest,
  useIdentity,
  useWorkspaceRole,
  canAdmin,
} from "./provider";
import styles from "./auth.module.css";
interface Member {
  id: string;
  name: string;
  email: string;
  role: "viewer" | "editor" | "admin" | "owner";
}
interface Details {
  members: Member[];
  invites: { id: string; email: string; role: string; expiresAt: string }[];
  retentionDays: number;
}
export function WorkspacesPanel() {
  const identity = useIdentity(),
    role = useWorkspaceRole(),
    active = identity.workspaces.find((w) => w.id === identity.workspaceId),
    [details, setDetails] = useState<Details | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const base = `/api/workspaces/${active?.id}`;
  useEffect(() => {
    let current = true;
    if (active && canAdmin(role) && !identity.local)
      void accountRequest(`/api/workspaces/${active.id}`, "GET")
        .then((d) => {
          if (current) setDetails(d);
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [active?.id, active, role, identity.local]);
  async function execute(
    path: string,
    method: string,
    body?: unknown,
    redirect = false,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await accountRequest(path, method, body);
      if (redirect) {
        navigateFresh("/projects");
        return;
      }
      await identity.refresh();
      if (active && canAdmin(role))
        try {
          setDetails(await accountRequest(base, "GET"));
        } catch {
          setDetails(null);
        }
      setMessage(data.message || "Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = new FormData(e.currentTarget).get("name");
    void execute("/api/workspaces", "POST", { name });
    e.currentTarget.reset();
  }
  return (
    <div className={styles.compact}>
      <div className={styles.status}>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {message && (
          <p role="status" className={styles.success}>
            {message}
          </p>
        )}
      </div>
      <section className={styles.section}>
        <h2>Your workspaces</h2>
        <ul className={styles.list}>
          {identity.workspaces.map((w) => (
            <li key={w.id}>
              <div className={styles.details}>
                <strong>{w.name}</strong>
                <small>
                  {w.role}
                  {w.id === identity.workspaceId ? " · Active" : ""}
                </small>
              </div>
              <div className={styles.row}>
                {w.id !== identity.workspaceId && (
                  <Button
                    disabled={busy}
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void execute(
                        `/api/workspaces/${w.id}/switch`,
                        "POST",
                        undefined,
                        true,
                      )
                    }
                  >
                    Switch
                  </Button>
                )}
                {!identity.local && (
                  <Button
                    disabled={busy}
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void execute(
                        `/api/workspaces/${w.id}/leave`,
                        "POST",
                        undefined,
                        true,
                      )
                    }
                  >
                    Leave
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {identity.local ? (
          <p className={styles.muted}>
            Enable accounts to create and invite people to workspaces.
          </p>
        ) : (
          <form onSubmit={create} className={styles.form}>
            <label>
              New workspace name
              <input className="input" name="name" required maxLength={100} />
            </label>
            <div>
              <Button disabled={busy}>Create workspace</Button>
            </div>
          </form>
        )}
      </section>
      {active && canAdmin(role) && !identity.local && (
        <>
          <section className={styles.section}>
            <h2>Workspace settings</h2>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                void execute(
                  base,
                  "PUT",
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
              }}
            >
              <label>
                Workspace name
                <input
                  className="input"
                  key={active.name}
                  name="name"
                  defaultValue={active.name}
                  required
                  maxLength={100}
                />
              </label>
              <div>
                <Button disabled={busy} variant="outline">
                  Rename workspace
                </Button>
              </div>
            </form>
          </section>
          <section className={styles.section}>
            <h2>Members</h2>
            <ul className={styles.list}>
              {details?.members.map((m) => (
                <li key={m.id}>
                  <div className={styles.details}>
                    <strong>
                      {m.name}
                      {m.id === identity.user?.id ? " (you)" : ""}
                    </strong>
                    <small>{m.email}</small>
                  </div>
                  <div className={styles.row}>
                    <FormSelect
                      label={`Role for ${m.name}`}
                      hiddenLabel
                      value={m.role}
                      disabled={
                        busy ||
                        (role !== "owner" &&
                          (m.role === "owner" ||
                            (m.role === "admin" && m.id !== identity.user?.id)))
                      }
                      options={[
                        { value: "viewer", label: "Viewer" },
                        { value: "editor", label: "Editor" },
                        ...(role === "owner" || m.role === "admin"
                          ? [{ value: "admin", label: "Admin" }]
                          : []),
                        ...(role === "owner" || m.role === "owner"
                          ? [{ value: "owner", label: "Owner" }]
                          : []),
                      ]}
                      onValueChange={(next) =>
                        void execute(`${base}/members/${m.id}`, "PUT", {
                          role: next,
                        })
                      }
                    />
                    {m.id !== identity.user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          busy ||
                          (role !== "owner" &&
                            ["owner", "admin"].includes(m.role))
                        }
                        onClick={() =>
                          void execute(`${base}/members/${m.id}`, "DELETE")
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          <section className={styles.section}>
            <h2>Invite a teammate</h2>
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                void execute(
                  `${base}/invites`,
                  "POST",
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
              }}
            >
              <label>
                Email
                <input
                  className="input"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                />
              </label>
              <FormSelect
                label="Role"
                name="role"
                options={[
                  { value: "viewer", label: "Viewer" },
                  { value: "editor", label: "Editor" },
                  ...(role === "owner"
                    ? [{ value: "admin", label: "Admin" }]
                    : []),
                ]}
              />
              <div>
                <Button disabled={busy}>Send invitation</Button>
              </div>
            </form>
            {!!details?.invites.length && (
              <>
                <h3>Pending invitations</h3>
                <ul className={styles.list}>
                  {details.invites.map((i) => (
                    <li key={i.id}>
                      <span>{i.email}</span>
                      <small>
                        {i.role} · Expires{" "}
                        {new Date(i.expiresAt).toLocaleDateString()}
                      </small>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {role === "owner" && (
            <section className={`${styles.section} ${styles.danger}`}>
              <h2>Ownership</h2>
              <p className={styles.muted}>
                Transfer ownership to another member. You will become an
                administrator.
              </p>
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  void execute(
                    `${base}/transfer`,
                    "POST",
                    Object.fromEntries(new FormData(e.currentTarget)),
                  );
                }}
              >
                <FormSelect
                  label="New owner"
                  name="userId"
                  options={[
                    { value: "", label: "Choose a member" },
                    ...(details?.members
                      .filter((m) => m.id !== identity.user?.id)
                      .map((m) => ({
                        value: m.id,
                        label: `${m.name} (${m.email})`,
                      })) ?? []),
                  ]}
                />
                <div>
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !details?.members.some((m) => m.id !== identity.user?.id)
                    }
                  >
                    Transfer ownership
                  </Button>
                </div>
              </form>
              <hr
                style={{
                  border: 0,
                  borderTop: "1px solid var(--line)",
                  margin: "24px 0",
                }}
              />
              {!confirmDelete ? (
                <Button
                  variant="outline"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete workspace…
                </Button>
              ) : (
                <div role="group" aria-label="Confirm workspace deletion">
                  <p>
                    This deletes access to {active.name} and its projects for
                    every member.
                  </p>
                  <div className={styles.row}>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void execute(base, "DELETE", undefined, true)
                      }
                    >
                      Delete workspace permanently
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep workspace
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
      <section className={styles.section}>
        <h2>Role legend</h2>
        <dl className={styles.legend}>
          <dt>Viewer</dt>
          <dd>
            Read dashboards, reports and Explore. Run semantic queries and
            download results.
          </dd>
          <dt>Editor</dt>
          <dd>
            Also create and edit projects, models, dashboards and reports,
            prepare data, and run loads.
          </dd>
          <dt>Admin</dt>
          <dd>
            Also manage SQL connections, members, schedules and workspace
            activity.
          </dd>
          <dt>Owner</dt>
          <dd>
            Also transfer ownership and delete the workspace. Every active
            workspace keeps at least one owner.
          </dd>
        </dl>
      </section>
    </div>
  );
}
