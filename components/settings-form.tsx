"use client";
import { useState } from "react";
import { Eye, EyeOff, LockKeyhole, Check } from "lucide-react";
import { ThemeChoice } from "./theme-provider";
import { Button } from "./ui/button";
export function SettingsForm() {
  const [connection, setConnection] = useState(
    "Server=localhost;Database=DataForge;Integrated Security=True;",
  );
  const [schema, setSchema] = useState("warehouse");
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  function save(section: string) {
    if (section === "schema" && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
      setError(
        "Use letters, numbers, and underscores. Start with a letter or underscore.",
      );
      return;
    }
    setError("");
    setSaved(section);
  }
  return (
    <div>
      <span className="sr-only" role="status">
        {saved ? "Changes saved for this preview." : ""}
      </span>
      <section className="panel settings-section" id="connection">
        <div className="panel-header">
          <h2>Database connection</h2>
          <LockKeyhole size={14} className="muted" />
        </div>
        <div className="panel-body">
          <label className="form-label" htmlFor="connection-string">
            Connection string
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="connection-string"
              className="mono"
              style={{ width: "100%", fontSize: 11 }}
              type={visible ? "text" : "password"}
              value={connection}
              onChange={(e) => {
                setConnection(e.target.value);
                setSaved("");
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => setVisible(!visible)}
              aria-label={
                visible ? "Hide connection string" : "Show connection string"
              }
              style={{ height: 38, width: 38 }}
            >
              {visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </Button>
          </div>
          <p className="form-hint">
            Sample connection only. Don’t enter real credentials in this demo.
          </p>
        </div>
        <div className="settings-footer">
          <p>No connection is made. Changes stay on this page.</p>
          <Button size="sm" onClick={() => save("connection")}>
            <span>
              {saved === "connection" ? "Saved locally" : "Save changes"}
            </span>
            {saved === "connection" && <Check size={12} />}
          </Button>
        </div>
      </section>
      <section className="panel settings-section" id="schema">
        <div className="panel-header">
          <h2>Warehouse defaults</h2>
        </div>
        <div className="panel-body">
          <label className="form-label" htmlFor="default-schema">
            Default schema
          </label>
          <input
            id="default-schema"
            className="mono"
            value={schema}
            onChange={(e) => {
              setSchema(e.target.value);
              setSaved("");
            }}
            style={{ width: "100%", fontSize: 12 }}
          />
          <p className="form-hint">
            The namespace for your generated fact and dimension tables.
          </p>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
        <div className="settings-footer">
          <p>Demo setting. Generated sample SQL is unchanged.</p>
          <Button size="sm" onClick={() => save("schema")}>
            <span>{saved === "schema" ? "Saved locally" : "Save changes"}</span>
            {saved === "schema" && <Check size={12} />}
          </Button>
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
