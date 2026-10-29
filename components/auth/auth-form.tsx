"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { accountRequest, navigateFresh } from "./provider";
import styles from "./auth.module.css";
type Mode =
  | "sign-in"
  | "sign-up"
  | "verify"
  | "forgot-password"
  | "reset-password"
  | "invite";
const titles: Record<Mode, string> = {
  "sign-in": "Welcome back.",
  "sign-up": "A fresh start for your data.",
  verify: "Verify your email.",
  "forgot-password": "Reset your password.",
  "reset-password": "Choose a new password.",
  invite: "Join your workspace.",
};
export function AuthForm({ mode, token = "" }: { mode: Mode; token?: string }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const action =
        mode === "invite"
          ? "/api/invites/accept"
          : `/api/auth/${mode === "verify" && !token ? "resend-verification" : mode}`;
      const body =
        (mode === "verify" && token) || mode === "invite"
          ? { token }
          : mode === "reset-password"
            ? { password: data.password, token }
            : data;
      const result = await accountRequest(action, "POST", body);
      if (mode === "sign-in") {
        navigateFresh(result.next || "/projects");
        return;
      }
      if (mode === "invite") {
        navigateFresh("/projects");
        return;
      }
      setMessage(result.message || "Done.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const email =
      ["sign-in", "sign-up", "forgot-password"].includes(mode) ||
      (mode === "verify" && !token),
    password = ["sign-in", "sign-up", "reset-password"].includes(mode);
  return (
    <main className={styles.authMain}>
      <div className={styles.authCard}>
        <p className="eyebrow">YOUR DATA, WITH THE RIGHT PEOPLE</p>
        <h1>{titles[mode]}</h1>
        <p className={styles.muted}>
          {mode === "verify"
            ? token
              ? "Confirm this single-use verification link to unlock your workspace."
              : "Check your inbox for a verification link, or request another below."
            : mode === "invite"
              ? "Sign in with the email address that received this invitation, then accept it below."
              : mode === "forgot-password"
                ? "We’ll send a single-use link if your address is eligible."
                : "Secure access to your DataForge workspaces."}
        </p>
        <form onSubmit={submit} className={styles.form}>
          {mode === "sign-up" && (
            <label>
              Name
              <input
                className="input"
                name="name"
                autoComplete="name"
                maxLength={100}
                required
              />
            </label>
          )}
          {email && (
            <label>
              Email
              <input
                className="input"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
              />
            </label>
          )}
          {password && (
            <>
              <label>
                Password
                <input
                  className="input"
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "sign-in" ? "current-password" : "new-password"
                  }
                  minLength={mode === "sign-in" ? undefined : 12}
                  maxLength={1024}
                  aria-describedby={
                    mode !== "sign-in" ? "password-help" : undefined
                  }
                  required
                />
              </label>
              {mode !== "sign-in" && (
                <small id="password-help">
                  At least 12 characters. Spaces and passphrases are welcome.
                </small>
              )}
            </>
          )}
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
          <Button disabled={busy}>
            {busy
              ? "Working…"
              : mode === "sign-in"
                ? "Sign in"
                : mode === "sign-up"
                  ? "Create account"
                  : mode === "verify"
                    ? token
                      ? "Verify email"
                      : "Send verification email"
                    : mode === "invite"
                      ? "Accept invitation"
                      : "Continue"}
          </Button>
        </form>
        <div className={styles.links}>
          {mode === "sign-in" ? (
            <>
              <Link href="/sign-up">Create an account</Link>
              <Link href="/forgot-password">Forgot password?</Link>
            </>
          ) : (
            <Link href="/sign-in">Sign in</Link>
          )}
        </div>
      </div>
    </main>
  );
}
