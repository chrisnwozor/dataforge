"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  ArrowDownUp,
  KeyRound,
  SlidersHorizontal,
  Check,
  Loader2,
} from "lucide-react";
import type { ColumnProfile, ColumnType } from "@/lib/types";
import { DataTable, EmptyState } from "./shared";
import { Button } from "./ui/button";
import { number } from "@/lib/utils";
type SortKey =
  "name" | "type" | "nullPercent" | "distinct" | "duplicates" | "min" | "max";
const apiTypes = {
  INT: "integer",
  DECIMAL: "decimal",
  DATE: "date",
  BOOLEAN: "boolean",
  VARCHAR: "text",
} as const;

export function ProfileTable({
  columns,
  projectId,
}: {
  columns: ColumnProfile[];
  projectId: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(columns);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({
    key: "name",
    asc: true,
  });
  const [sorted, setSorted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [baseline, setBaseline] = useState(
    () => new Map(columns.map((column) => [column.id, column.type])),
  );
  const changedRows = rows.filter(
    (column) => column.type !== baseline.get(column.id),
  );

  async function saveOverrides() {
    if (saving || changedRows.length === 0) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/profile`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            overrides: changedRows.map((column) => ({
              ordinal: column.ordinal ?? Number(column.id),
              type:
                column.type === column.inferredType
                  ? null
                  : apiTypes[column.type],
            })),
          }),
        },
      );
      const result = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!response.ok)
        throw new Error(
          result?.error ||
            "Type overrides could not be saved. Please try again.",
        );
      setBaseline(new Map(rows.map((column) => [column.id, column.type])));
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }
  const visible = useMemo(() => {
    const filtered = rows.filter(
      (c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) &&
        (filter === "all" ||
          (filter === "keys" && (c.keyCandidate || c.nearKeyCandidate)) ||
          (filter === "nulls" && c.nullPercent > 0)),
    );
    return sorted
      ? filtered.toSorted((a, b) => {
          const av = a[sort.key],
            bv = b[sort.key];
          return (
            (typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av).localeCompare(String(bv))) * (sort.asc ? 1 : -1)
          );
        })
      : filtered;
  }, [rows, search, filter, sort, sorted]);
  function order(key: SortKey) {
    setSorted(true);
    setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));
  }
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <label className="search-field">
            <Search size={14} />
            <input
              aria-label="Search columns"
              placeholder="Search columns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select
            aria-label="Filter columns"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ fontSize: 11, height: 36 }}
          >
            <option value="all">All columns</option>
            <option value="keys">Key candidates</option>
            <option value="nulls">With null values</option>
          </select>
        </div>
        <Button
          variant="outline"
          onClick={saveOverrides}
          disabled={saving || changedRows.length === 0}
        >
          {saving ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {saving ? "Saving…" : saved ? "Overrides saved" : "Save overrides"}
        </Button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" role="status">
        {saved ? "Type overrides saved to this project." : ""}
      </span>
      {visible.length ? (
        <DataTable>
          <thead>
            <tr>
              {(
                [
                  "name",
                  "type",
                  "nullPercent",
                  "distinct",
                  "duplicates",
                  "min",
                  "max",
                ] as SortKey[]
              ).map((k, i) => (
                <th
                  key={k}
                  aria-sort={
                    sorted && sort.key === k
                      ? sort.asc
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button onClick={() => order(k)}>
                    {
                      [
                        "Column",
                        "Inferred type",
                        "Null %",
                        "Distinct",
                        "Duplicates",
                        "Min",
                        "Max",
                      ][i]
                    }
                    <ArrowDownUp size={10} />
                  </button>
                </th>
              ))}
              <th>Key candidate</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id}>
                <td className="mono">{c.name}</td>
                <td>
                  <select
                    className="type-select"
                    aria-label={`Override type for ${c.name}`}
                    value={c.type}
                    disabled={saving}
                    onChange={(e) => {
                      setRows((r) =>
                        r.map((x) =>
                          x.id === c.id
                            ? { ...x, type: e.target.value as ColumnType }
                            : x,
                        ),
                      );
                      setSaved(false);
                      setError("");
                    }}
                  >
                    {["VARCHAR", "INT", "DECIMAL", "DATE", "BOOLEAN"].map(
                      (t) => (
                        <option key={t}>{t}</option>
                      ),
                    )}
                  </select>
                </td>
                <td>
                  <div className="null-cell mono">
                    <span style={{ minWidth: 30 }}>{c.nullPercent}%</span>
                    <div className="null-bar">
                      <span
                        style={{
                          width: `${c.nullPercent}%`,
                          minWidth: c.nullPercent ? 2 : 0,
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td className="mono">{number(c.distinct)}</td>
                <td className="mono muted">{number(c.duplicates)}</td>
                <td className="mono muted small">{c.min}</td>
                <td className="mono muted small">{c.max}</td>
                <td>
                  {c.keyCandidate || c.nearKeyCandidate ? (
                    <span
                      className="key-badge"
                      title={
                        c.keyCandidate
                          ? "Every value is distinct, with no nulls."
                          : "At least 99.5% of values are distinct, with no nulls."
                      }
                      style={{
                        display: "inline-flex",
                        gap: 4,
                        alignItems: "center",
                      }}
                    >
                      <KeyRound size={10} />
                      {c.keyCandidate ? "Key" : "Near-key"}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <EmptyState
          title="No matching columns"
          description="Try another search or choose a different filter."
        />
      )}
      <div className="table-foot">
        <span>
          {visible.length} of {columns.length} columns
        </span>
        <span>
          {changedRows.length
            ? `${changedRows.length} unsaved type ${changedRows.length === 1 ? "override" : "overrides"}`
            : "Type overrides are saved with this project."}
        </span>
      </div>
      <div className="info-banner">
        <SlidersHorizontal size={16} />
        <span>
          <strong>You know your data best.</strong> Inferred types are a
          starting point. Adjust them before shaping your model.
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <KeyRound size={11} />
          {columns.filter((c) => c.keyCandidate).length} keys ·{" "}
          {columns.filter((c) => c.nearKeyCandidate).length} near-keys
        </span>
      </div>
    </>
  );
}
