"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { accountRequest, useIdentity } from "./provider";
import styles from "./auth.module.css";
interface Event {
  id: string;
  createdAt: string;
  userName: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  ip: string;
  metadata: Record<string, unknown>;
}
export function ActivityPanel() {
  const identity = useIdentity(),
    [events, setEvents] = useState<Event[]>([]),
    [action, setAction] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState(""),
    [days, setDays] = useState(365),
    [message, setMessage] = useState("");
  const query = new URLSearchParams({
    ...(action ? { action } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00Z`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T23:59:59Z`).toISOString() } : {}),
  }).toString();
  const load = useCallback(async () => {
    try {
      const d = await accountRequest(`/api/activity?${query}`, "GET");
      setEvents(d.events);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load activity.");
    }
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/activity?${query}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not load activity.");
        if (!controller.signal.aborted) {
          setEvents(d.events);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [query]);
  useEffect(() => {
    if (identity.workspaceId && !identity.local)
      void accountRequest(`/api/workspaces/${identity.workspaceId}`, "GET")
        .then((d) => setDays(d.retentionDays))
        .catch(() => {});
  }, [identity.workspaceId, identity.local]);
  return (
    <>
      <section className={styles.section}>
        <div className={styles.row}>
          <label className={styles.field}>
            Action
            <input
              className="input"
              placeholder="e.g. auth.signed_in"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            From
            <input
              className="input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            Through
            <input
              className="input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <a
            className="button button-outline"
            href={`/api/activity?${query}&format=csv`}
          >
            Export activity CSV
          </a>
        </div>
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.scroll}>
          <table className={styles.table}>
            <caption className="sr-only">
              Workspace audit events, newest first
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Target</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td>{e.userName || "System / account"}</td>
                  <td>{e.action}</td>
                  <td>
                    {e.targetType}
                    <br />
                    <small>{e.targetId}</small>
                  </td>
                  <td>
                    {Object.entries(e.metadata)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!events.length && (
            <p className={styles.muted}>No activity matches these filters.</p>
          )}
        </div>
        <p className={styles.muted}>
          Showing the latest 200 events. CSV export includes up to 10,000.
        </p>
      </section>
      <section className={styles.section}>
        <h2>Audit retention</h2>
        <form
          className={styles.row}
          onSubmit={(e) => {
            e.preventDefault();
            void accountRequest("/api/activity", "PUT", { days })
              .then(() => {
                setMessage("Retention saved.");
                void load();
              })
              .catch((e) => setError(e.message));
          }}
        >
          <label className={styles.field}>
            Days
            <input
              className="input"
              type="number"
              min={1}
              max={3650}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          <Button variant="outline">Save retention</Button>
        </form>
        {message && (
          <p role="status" className={styles.success}>
            {message}
          </p>
        )}
      </section>
    </>
  );
}
