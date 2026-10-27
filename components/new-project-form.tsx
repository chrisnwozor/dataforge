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

type UploadResponse = { project?: { id?: string }; error?: string };
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export function NewProjectForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("SQL Server 2022");
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const request = useRef<XMLHttpRequest | null>(null);
  useEffect(
    () => () => {
      if (request.current) {
        request.current.onabort = null;
        request.current.abort();
      }
    },
    [],
  );

  function chooseFile(picked: File | undefined) {
    if (!picked || submitting) return;
    if (!/\.(csv|xlsx)$/i.test(picked.name)) {
      setError("Choose a .csv or .xlsx file.");
      return;
    }
    if (picked.size > MAX_FILE_SIZE) {
      setError("Choose a file that is 50 MB or smaller.");
      return;
    }
    if (picked.size === 0) {
      setError("Choose a file that contains data.");
      return;
    }
    setError("");
    setFile(picked);
    setName(
      (current) =>
        current || picked.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
    );
    setProgress(0);
  }

  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !name.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    setProgress(0);

    const body = new FormData();
    body.append("name", name.trim());
    body.append("file", file);
    body.append("targetDatabase", target);
    const xhr = new XMLHttpRequest();
    request.current = xhr;

    function fail(message: string) {
      request.current = null;
      setError(message);
      setSubmitting(false);
    }

    xhr.upload.onprogress = (upload) => {
      if (upload.lengthComputable) {
        setProgress(
          Math.min(100, Math.round((upload.loaded / upload.total) * 100)),
        );
      }
    };
    xhr.upload.onload = () => setProgress(100);
    xhr.onload = () => {
      request.current = null;
      const response = xhr.response as UploadResponse | null;
      if (xhr.status >= 200 && xhr.status < 300 && response?.project?.id) {
        setProgress(100);
        router.push(
          `/projects/${encodeURIComponent(response.project.id)}/profile`,
        );
        router.refresh();
        return;
      }
      fail(
        response?.error || `Upload failed (${xhr.status}). Please try again.`,
      );
    };
    xhr.onerror = () =>
      fail(
        "The upload could not reach the server. Check your connection and try again.",
      );
    xhr.onabort = () =>
      fail("Upload cancelled. Choose your file and try again.");
    try {
      xhr.open("POST", "/api/projects");
      xhr.responseType = "json";
      xhr.send(body);
    } catch {
      fail("The upload could not start. Please try again.");
    }
  }

  const uploadMessage = submitting
    ? progress === 100
      ? "Upload complete. Profiling your data…"
      : `Uploading… ${progress}%`
    : error
      ? "Upload needs attention. You can retry with this file."
      : "Ready to upload and profile";

  return (
    <form onSubmit={submit}>
      <div className="form-group">
        <label
          className="form-label"
          htmlFor={file ? undefined : "source-file"}
        >
          Source file
        </label>
        {!file ? (
          <div
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files[0]);
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
              disabled={submitting}
              onChange={(event) => chooseFile(event.target.files?.[0])}
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
                aria-label="Upload progress"
                aria-valuetext={uploadMessage}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="form-hint" role="status">
                {uploadMessage}
              </div>
            </div>
            {progress === 100 && !error ? (
              <Check size={16} style={{ color: "var(--green)" }} />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove file"
              disabled={submitting}
              onClick={() => {
                setFile(null);
                setProgress(0);
                setError("");
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
          Your file is saved on this server and profiled before you continue.
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
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={80}
          disabled={submitting}
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
          onChange={(event) => setTarget(event.target.value)}
          disabled={submitting}
        >
          <option>SQL Server 2022</option>
          <option>SQL Server 2019</option>
          <option>Azure SQL Database</option>
        </select>
        <p className="form-hint">
          Target selection is reserved for a later phase. No database connection
          is made.
        </p>
      </div>
      <div className="form-actions">
        <span className="notice">
          <LockKeyhole size={12} />
          Private by design
        </span>
        <Button type="submit" disabled={!file || !name.trim() || submitting}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {submitting
            ? progress === 100
              ? "Profiling…"
              : "Uploading…"
            : "Continue to profile"}{" "}
          <ArrowRight size={14} />
        </Button>
      </div>
    </form>
  );
}
