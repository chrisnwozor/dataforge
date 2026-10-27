"use client";
import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileSpreadsheet,
  X,
  Check,
  ArrowRight,
  LockKeyhole,
  Loader2,
} from "lucide-react";
import { Button } from "./ui/button";
export function NewProjectForm() {
  const router = useRouter();
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("SQL Server 2022");
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );
  function chooseFile(picked: File | undefined) {
    if (!picked) return;
    if (!/\.(csv|xlsx)$/i.test(picked.name)) {
      setError("Choose a .csv or .xlsx file.");
      return;
    }
    if (picked.size > 50 * 1024 * 1024) {
      setError("Choose a file smaller than 50 MB.");
      return;
    }
    if (timer.current) clearInterval(timer.current);
    setError("");
    setFile({ name: picked.name, size: picked.size });
    setName(
      (n) => n || picked.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
    );
    setProgress(0);
    let next = 0;
    timer.current = setInterval(() => {
      next += 20;
      setProgress(next);
      if (next >= 100 && timer.current) clearInterval(timer.current);
    }, 120);
  }
  function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file || progress < 100 || !name.trim()) return;
    setSubmitting(true);
    sessionStorage.setItem(
      "dataforge-project",
      JSON.stringify({
        name: name.trim(),
        sourceName: file.name,
        sourceType: file.name.endsWith(".xlsx") ? "XLSX" : "CSV",
        target,
      }),
    );
    router.push("/projects/new-project");
  }
  return (
    <form onSubmit={submit}>
      <div className="form-group">
        <label className="form-label" htmlFor="source-file">
          Source file
        </label>
        {!file ? (
          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              chooseFile(e.dataTransfer.files[0]);
            }}
          >
            <div className="drop-icon">
              <Upload size={22} />
            </div>
            <p>
              Drop your file here, or{" "}
              <span
                style={{ textDecoration: "underline", textUnderlineOffset: 3 }}
              >
                browse files
              </span>
            </p>
            <small>CSV or XLSX · Up to 50 MB</small>
            <input
              id="source-file"
              type="file"
              accept=".csv,.xlsx"
              aria-label="Upload a CSV or Excel file"
              onChange={(e) => chooseFile(e.target.files?.[0])}
            />
          </div>
        ) : (
          <div className="upload-file">
            <FileSpreadsheet size={23} className="muted" />
            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                }}
              >
                <span>{file.name}</span>
                <span className="muted mono">
                  {(file.size / 1024).toFixed(1)} KB
                </span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Simulated upload progress"
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="form-hint">
                {progress === 100
                  ? "Ready to preview sample data"
                  : `Simulating upload… ${progress}%`}
              </div>
            </div>
            {progress === 100 ? (
              <Check size={16} style={{ color: "var(--green)" }} />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove file"
              onClick={() => {
                if (timer.current) clearInterval(timer.current);
                setFile(null);
                setProgress(0);
              }}
            >
              <X size={14} />
            </Button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <p className="form-hint">
          Demo only. Your file stays in your browser and is never read or
          uploaded.
        </p>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          placeholder="e.g. Superstore Sales"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
        />
        <p className="form-hint">
          Give your data a name that makes sense to your team.
        </p>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="target-database">
          Target database
        </label>
        <select
          id="target-database"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option>SQL Server 2022</option>
          <option>SQL Server 2019</option>
          <option>Azure SQL Database</option>
        </select>
        <p className="form-hint">
          We’ll generate T-SQL for your selected target. No connection required.
        </p>
      </div>
      <div className="form-actions">
        <span className="notice">
          <LockKeyhole size={12} />
          Private by design
        </span>
        <Button
          type="submit"
          disabled={!file || progress < 100 || !name.trim() || submitting}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          Continue to project <ArrowRight size={14} />
        </Button>
      </div>
    </form>
  );
}
