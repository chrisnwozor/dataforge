"use client";
import { useState } from "react";
import { Copy, Check, Download, FileCode2 } from "lucide-react";
import type { GeneratedFile } from "@/lib/types";
import { Button } from "./ui/button";
function highlight(line: string) {
  if (line.trim().startsWith("--"))
    return <span className="code-comment">{line}</span>;
  return line
    .split(
      /(\b(?:CREATE|TABLE|SCHEMA|GO|NOT|NULL|DEFAULT|PRIMARY|KEY|REFERENCES|IDENTITY|UNIQUE|INSERT|INTO|VALUES|VARCHAR|INT|BIGINT|DATE|DATETIME2|DECIMAL|SYSUTCDATETIME)\b|'[^']*')/g,
    )
    .map((piece, i) =>
      /^(CREATE|TABLE|SCHEMA|GO|NOT|NULL|DEFAULT|PRIMARY|KEY|REFERENCES|IDENTITY|UNIQUE|INSERT|INTO|VALUES|VARCHAR|INT|BIGINT|DATE|DATETIME2|DECIMAL|SYSUTCDATETIME)$/.test(
        piece,
      ) ? (
        <span key={i} className="code-keyword">
          {piece}
        </span>
      ) : piece.startsWith("'") ? (
        <span key={i} className="code-string">
          {piece}
        </span>
      ) : (
        piece
      ),
    );
}
export function CodeViewer({ files }: { files: GeneratedFile[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const file = files[active];
  async function copy() {
    try {
      await navigator.clipboard.writeText(file.content);
      setCopied(true);
      setNotice("SQL copied to clipboard.");
    } catch {
      setNotice("Clipboard unavailable. Select and copy the SQL below.");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([file.content], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(`${file.name} downloaded.`);
  }
  return (
    <div className="code-panel">
      <div
        className="code-tabs"
        role="tablist"
        aria-label="Generated SQL files"
      >
        {files.map((f, i) => (
          <button
            key={f.name}
            role="tab"
            id={`file-tab-${i}`}
            aria-controls="sql-panel"
            tabIndex={active === i ? 0 : -1}
            aria-selected={active === i}
            onClick={() => {
              setActive(i);
              setCopied(false);
              setNotice("");
            }}
            onKeyDown={(e) => {
              if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? files.length - 1
                      : (i + (e.key === "ArrowRight" ? 1 : files.length - 1)) %
                        files.length;
                setActive(next);
                setCopied(false);
                document.getElementById(`file-tab-${next}`)?.focus();
              }
            }}
          >
            {f.name}
          </button>
        ))}
      </div>
      <div className="code-toolbar">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <FileCode2 size={12} />
          T-SQL <span>·</span> UTF-8
        </span>
        <div className="code-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={copy}
            aria-label="Copy SQL"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={download}
            aria-label="Download SQL file"
          >
            <Download size={12} />
            Download
          </Button>
        </div>
      </div>
      <div
        id="sql-panel"
        role="tabpanel"
        aria-labelledby={`file-tab-${active}`}
        tabIndex={0}
        className="code-lines"
      >
        {file.content.split("\n").map((line, i) => (
          <div className="code-line" key={i}>
            <span className="line-number" aria-hidden="true">
              {i + 1}
            </span>
            <code>{highlight(line) || " "}</code>
          </div>
        ))}
      </div>
      <div className="code-toolbar">
        <span>{file.content.split("\n").length} lines</span>
        <span role="status">
          {notice || "Generated from the suggested sample model"}
        </span>
      </div>
    </div>
  );
}
