"use client";

import { useId, useState } from "react";
import {
  Copy,
  Check,
  Download,
  FileCode2,
  Package,
  Loader2,
} from "lucide-react";
import type { GeneratedFile } from "@/lib/sql/types";
import { Button } from "./ui/button";

function highlight(line: string) {
  if (line.trim().startsWith("--"))
    return <span className="code-comment">{line}</span>;
  return line
    .split(
      /(\b(?:CREATE|ALTER|TABLE|SCHEMA|GO|NOT|NULL|DEFAULT|PRIMARY|FOREIGN|KEY|REFERENCES|IDENTITY|UNIQUE|INSERT|INTO|VALUES|NVARCHAR|VARCHAR|INT|BIGINT|BIT|DATE|DATETIME2|DECIMAL|SYSUTCDATETIME|SELECT|FROM|WHERE|JOIN|MERGE|WHEN|MATCHED|UPDATE|SET|TRY_CONVERT|BEGIN|END|TRY|CATCH|TRANSACTION|COMMIT|ROLLBACK|TRUNCATE|IF|EXISTS|AS|ON|USE|DECLARE|WITH|ROW_NUMBER|PARTITION|BY|ORDER|CASE|THEN|ELSE|THROW)\b|N?'(?:''|[^'])*')/g,
    )
    .map((piece, i) =>
      /^(?:CREATE|ALTER|TABLE|SCHEMA|GO|NOT|NULL|DEFAULT|PRIMARY|FOREIGN|KEY|REFERENCES|IDENTITY|UNIQUE|INSERT|INTO|VALUES|NVARCHAR|VARCHAR|INT|BIGINT|BIT|DATE|DATETIME2|DECIMAL|SYSUTCDATETIME|SELECT|FROM|WHERE|JOIN|MERGE|WHEN|MATCHED|UPDATE|SET|TRY_CONVERT|BEGIN|END|TRY|CATCH|TRANSACTION|COMMIT|ROLLBACK|TRUNCATE|IF|EXISTS|AS|ON|USE|DECLARE|WITH|ROW_NUMBER|PARTITION|BY|ORDER|CASE|THEN|ELSE|THROW)$/.test(
        piece,
      ) ? (
        <span key={i} className="code-keyword">
          {piece}
        </span>
      ) : /^(?:N)?'/.test(piece) ? (
        <span key={i} className="code-string">
          {piece}
        </span>
      ) : (
        piece
      ),
    );
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CodeViewer({
  files,
  downloadsDisabled,
  zipUrl,
  loading,
}: {
  files: GeneratedFile[];
  downloadsDisabled: boolean;
  zipUrl: string;
  loading: boolean;
}) {
  const [activeName, setActiveName] = useState(
    files[0]?.name ?? "00_setup.sql",
  );
  const [copiedSql, setCopiedSql] = useState("");
  const [notice, setNotice] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [zipping, setZipping] = useState(false);
  const id = useId();
  const file = files.find((item) => item.name === activeName) ?? files[0];
  const active = file ? files.indexOf(file) : 0;

  async function copy() {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.sql);
      setCopiedSql(file.sql);
      setNotice("SQL copied to clipboard.");
    } catch {
      setNotice("Clipboard unavailable. Select and copy the SQL below.");
    }
  }
  function download() {
    if (!file || downloadsDisabled) return;
    saveBlob(
      new Blob([file.sql], { type: "application/sql;charset=utf-8" }),
      file.name,
    );
    setNotice(`${file.name} downloaded.`);
  }
  async function downloadAll() {
    if (downloadsDisabled || zipping) return;
    setZipping(true);
    setDownloadError("");
    try {
      const response = await fetch(zipUrl);
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          result?.error || "The scripts could not be downloaded. Try again.",
        );
      }
      const filename =
        /filename="([^"]+)"/.exec(
          response.headers.get("content-disposition") || "",
        )?.[1] || "dataforge-sql.zip";
      saveBlob(await response.blob(), filename);
      setNotice("All SQL scripts downloaded.");
    } catch (error) {
      setDownloadError(
        error instanceof Error
          ? error.message
          : "The download failed. Try again.",
      );
    } finally {
      setZipping(false);
    }
  }
  return (
    <div className="generate-code-column">
      <div className="code-panel" aria-busy={loading}>
        {files.length > 0 && (
          <div
            className="code-tabs"
            role="tablist"
            aria-label="Generated SQL files"
          >
            {files.map((item, index) => (
              <button
                key={item.name}
                role="tab"
                id={`${id}-file-tab-${index}`}
                aria-controls={`${id}-sql-panel`}
                tabIndex={active === index ? 0 : -1}
                aria-selected={active === index}
                onClick={() => {
                  setActiveName(item.name);
                  setNotice("");
                  setDownloadError("");
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? files.length - 1
                        : (index +
                            (event.key === "ArrowRight"
                              ? 1
                              : files.length - 1)) %
                          files.length;
                  setActiveName(files[next].name);
                  setNotice("");
                  document.getElementById(`${id}-file-tab-${next}`)?.focus();
                }}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        <div className="code-toolbar generate-code-toolbar">
          <span className="generate-code-language">
            <FileCode2 size={12} /> T-SQL <span>·</span> UTF-8
          </span>
          <div className="code-actions generate-code-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={copy}
              disabled={!file || downloadsDisabled}
              aria-label={
                file && copiedSql === file.sql ? "Copied SQL" : "Copy SQL"
              }
            >
              {file && copiedSql === file.sql ? (
                <Check size={12} />
              ) : (
                <Copy size={12} />
              )}
              <span>{file && copiedSql === file.sql ? "Copied" : "Copy"}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={download}
              disabled={!file || downloadsDisabled}
              aria-label="Download SQL file"
            >
              <Download size={12} /> Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void downloadAll()}
              disabled={!file || downloadsDisabled || zipping}
            >
              {zipping ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Package size={12} />
              )}{" "}
              Download all (.zip)
            </Button>
          </div>
        </div>
        {file ? (
          <div
            id={`${id}-sql-panel`}
            role="tabpanel"
            aria-labelledby={`${id}-file-tab-${active}`}
            tabIndex={0}
            className="code-lines generate-code-lines"
          >
            {file.sql.split("\n").map((line, index) => (
              <div className="code-line" key={index}>
                <span className="line-number" aria-hidden="true">
                  {index + 1}
                </span>
                <code>{highlight(line) || " "}</code>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state generate-empty-code">
            <FileCode2 size={24} />
            <span>Resolve the model errors to generate your scripts.</span>
          </div>
        )}
        <div className="code-toolbar generate-code-footer">
          <span>
            {file
              ? `${file.sql.split("\n").length} lines`
              : "No files generated"}
          </span>
          <span role="status">
            {loading
              ? "Regenerating scripts…"
              : notice || "Generated from your saved model"}
          </span>
        </div>
      </div>
      {downloadError && (
        <p className="inline-error" role="alert">
          {downloadError}
        </p>
      )}
      {file && (
        <section
          className="panel generate-summary"
          aria-labelledby={`${id}-summary-title`}
        >
          <div className="panel-header">
            <h2 id={`${id}-summary-title`}>What this does</h2>
            <span className="mono small muted">{file.name}</span>
          </div>
          <div className="panel-body">
            <p>{file.description}</p>
          </div>
        </section>
      )}
    </div>
  );
}
