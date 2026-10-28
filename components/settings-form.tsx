"use client";

import { useRef, useState } from "react";
import { Eye, EyeOff, LockKeyhole, Check, Loader2, Plug } from "lucide-react";
import type { PublicConnection } from "@/lib/server/connection";
import { ThemeChoice } from "./theme-provider";
import { Button } from "./ui/button";

type FormValues = Pick<
  PublicConnection,
  | "server"
  | "database"
  | "user"
  | "encrypt"
  | "trustServerCertificate"
  | "stagingFolder"
> & { port: string };

function formValues(connection: PublicConnection): FormValues {
  return {
    server: connection.server,
    port: String(connection.port),
    database: connection.database,
    user: connection.user,
    encrypt: connection.encrypt,
    trustServerCertificate: connection.trustServerCertificate,
    stagingFolder: connection.stagingFolder,
  };
}

export function SettingsForm({
  initialConnection,
}: {
  initialConnection: PublicConnection;
}) {
  const [connection, setConnection] = useState(initialConnection);
  const [fields, setFields] = useState(() => formValues(initialConnection));
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<{
    message: string;
    version?: string;
  } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const busy = saving || testing;

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setError("");
    setTestResult(null);
  }
  async function request(test: boolean) {
    if (busy || !form.current?.reportValidity()) return;
    setError("");
    setTestResult(null);
    if (test) setTesting(true);
    else setSaving(true);
    try {
      const response = await fetch(
        `/api/settings/connection${test ? "/test" : ""}`,
        {
          method: test ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...fields,
            port: Number(fields.port),
            ...(password ? { password } : {}),
          }),
        },
      );
      const result = (await response.json()) as {
        connection?: PublicConnection;
        message?: string;
        version?: string;
        database?: string;
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          result.error ||
            (test
              ? "The connection could not be tested."
              : "The connection could not be saved."),
        );
      if (test) {
        setTestResult({
          message:
            result.message ||
            `Connected to ${result.database || fields.database}.`,
          version: result.version,
        });
      } else {
        if (!result.connection)
          throw new Error("The saved connection could not be read. Try again.");
        setConnection(result.connection);
        setFields(formValues(result.connection));
        setPassword("");
        setVisible(false);
        setSaved(true);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Try again.",
      );
    } finally {
      setSaving(false);
      setTesting(false);
    }
  }

  return (
    <div>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          void request(false);
        }}
      >
        <fieldset disabled={busy} className="connection-fields">
          <section className="panel settings-section" id="connection">
            <div className="panel-header">
              <h2>Database connection</h2>
              <LockKeyhole size={14} className="muted" />
            </div>
            <div className="panel-body">
              <p className="connection-intro">
                Connect with a SQL Server login. Windows authentication is
                outside this phase.
              </p>
              {connection.configurationError && (
                <div className="info-banner connection-secret-note">
                  <LockKeyhole size={14} />
                  <span>
                    {connection.configurationError} See the README for the
                    key-generation command and setup steps.
                  </span>
                </div>
              )}
              <div className="connection-form-grid">
                <div>
                  <label className="form-label" htmlFor="sql-server">
                    Server
                  </label>
                  <input
                    id="sql-server"
                    value={fields.server}
                    onChange={(event) => update("server", event.target.value)}
                    required
                    maxLength={255}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="localhost"
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="sql-port">
                    Port
                  </label>
                  <input
                    id="sql-port"
                    type="number"
                    inputMode="numeric"
                    value={fields.port}
                    onChange={(event) => update("port", event.target.value)}
                    required
                    min={1}
                    max={65535}
                    step={1}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="sql-database">
                    Database
                  </label>
                  <input
                    id="sql-database"
                    value={fields.database}
                    onChange={(event) => update("database", event.target.value)}
                    required
                    maxLength={128}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="sql-user">
                    User
                  </label>
                  <input
                    id="sql-user"
                    value={fields.user}
                    onChange={(event) => update("user", event.target.value)}
                    required
                    maxLength={128}
                    autoComplete="username"
                    spellCheck={false}
                  />
                </div>
                <div className="connection-full-width">
                  <label className="form-label" htmlFor="sql-password">
                    Password
                  </label>
                  <div className="connection-password">
                    <input
                      id="sql-password"
                      type={visible ? "text" : "password"}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setSaved(false);
                        setError("");
                        setTestResult(null);
                      }}
                      required={!connection.passwordSaved}
                      maxLength={1024}
                      autoComplete="new-password"
                      placeholder={
                        connection.passwordSaved
                          ? "•••••••• (saved)"
                          : "Enter SQL login password"
                      }
                      aria-describedby="sql-password-help"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => setVisible(!visible)}
                      disabled={!password}
                      aria-label={
                        visible
                          ? "Hide entered password"
                          : "Show entered password"
                      }
                    >
                      {visible ? <EyeOff size={15} /> : <Eye size={15} />}
                    </Button>
                  </div>
                  <p className="form-hint" id="sql-password-help">
                    {connection.passwordSaved
                      ? "A password is saved and masked. Leave this field blank to keep it, or enter a replacement."
                      : "The password is encrypted on the server and is never returned to this form."}
                  </p>
                </div>
                <div className="connection-full-width">
                  <label className="form-label" htmlFor="sql-staging-folder">
                    Staging folder
                  </label>
                  <input
                    id="sql-staging-folder"
                    className="mono"
                    value={fields.stagingFolder}
                    onChange={(event) =>
                      update("stagingFolder", event.target.value)
                    }
                    required
                    maxLength={3900}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="C:\Temp"
                    aria-describedby="sql-staging-help"
                  />
                  <p className="form-hint" id="sql-staging-help">
                    A folder DataForge can write to and SQL Server can read. For
                    a remote SQL Server, mount a shared folder on the app server
                    and configure <code>DATAFORGE_STAGING_WRITE_DIR</code> to
                    map it to this SQL Server path.
                  </p>
                </div>
              </div>
              <div className="connection-security-options">
                <label>
                  <input
                    type="checkbox"
                    checked={fields.encrypt}
                    onChange={(event) =>
                      update("encrypt", event.target.checked)
                    }
                  />
                  <span>Encrypt connection</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={fields.trustServerCertificate}
                    onChange={(event) =>
                      update("trustServerCertificate", event.target.checked)
                    }
                  />
                  <span>Trust server certificate</span>
                </label>
              </div>
              <p className="form-hint">
                Trusting the server certificate is useful for local development.
                Use a trusted SQL Server certificate when deploying.
              </p>
              {error && (
                <p className="inline-error connection-response" role="alert">
                  {error}
                </p>
              )}
              {testResult && (
                <div
                  className="connection-response connection-test-success"
                  role="status"
                >
                  <p>
                    <Check size={13} />
                    {testResult.message}
                  </p>
                  {testResult.version && (
                    <details>
                      <summary>SQL Server version</summary>
                      <pre className="mono">{testResult.version}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
            <div className="settings-footer connection-footer">
              <p role="status">
                {saved
                  ? "Connection saved. Password masked."
                  : connection.passwordSaved
                    ? "Password saved and masked."
                    : "Save the connection before starting a load."}
              </p>
              <div className="connection-actions">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void request(true)}
                >
                  {testing ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Plug size={13} />
                  )}
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button type="submit" size="sm">
                  {saving ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : saved ? (
                    <Check size={13} />
                  ) : null}
                  {saving ? "Saving…" : saved ? "Saved" : "Save connection"}
                </Button>
              </div>
            </div>
          </section>
        </fieldset>
      </form>
      <section className="panel settings-section" id="schema">
        <div className="panel-header">
          <h2>Warehouse defaults</h2>
        </div>
        <div className="panel-body">
          <div className="detail-row">
            <span>Staging schema</span>
            <span className="mono">stg</span>
          </div>
          <div className="detail-row">
            <span>Warehouse schema</span>
            <span className="mono">dw</span>
          </div>
          <div className="detail-row">
            <span>Execution logs</span>
            <span className="mono">etl</span>
          </div>
          <p className="form-hint">
            Generated scripts use these schemas in the configured database.
            Review the model and load confirmation before running.
          </p>
        </div>
      </section>
      <section className="panel settings-section" id="appearance">
        <div className="panel-header">
          <h2>Appearance</h2>
        </div>
        <div className="panel-body">
          <label className="form-label">Interface theme</label>
          <p className="help-text" style={{ marginBottom: 16 }}>
            Choose what feels right. Your preference is saved in this browser.
          </p>
          <ThemeChoice />
        </div>
      </section>
    </div>
  );
}
