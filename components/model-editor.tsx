"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  GripVertical,
  Plus,
  WandSparkles,
  Pencil,
  Table2,
  KeyRound,
  ArrowRight,
  Check,
  Undo2,
  X,
  Info,
  ChevronDown,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import type { ColumnProfile } from "@/lib/types";
import type { Aggregation, Dimension, Model } from "@/lib/modeling/types";
import { modelReducer, type ModelAction } from "@/lib/modeling/editor";
import { validateModel } from "@/lib/modeling/validate";
import { Button, buttonVariants } from "./ui/button";
import { SelectMenu } from "./select-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";

function Reason({ text, label }: { text: string; label: string }) {
  const id = useId();
  if (!text) return null;
  return (
    <span className="model-reason-wrap">
      <button
        type="button"
        className="model-reason"
        aria-label={`Why ${label}?`}
        aria-describedby={id}
        title={text}
      >
        <Info size={11} />
      </button>
      <span role="tooltip" id={id} className="model-tooltip">
        {text}
      </span>
    </span>
  );
}

function Rename({
  name,
  label,
  onRename,
  table = false,
}: {
  name: string;
  label: string;
  onRename: (name: string) => void;
  table?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const finished = useRef(false);
  function save() {
    if (finished.current) return;
    finished.current = true;
    const next = table
      ? value.trim().replace(/[^a-zA-Z0-9_]/g, "_")
      : value.trim();
    if (next && next !== name) onRename(next);
    setEditing(false);
  }
  return editing ? (
    <input
      className="rename-input"
      aria-label={`${table ? "Table" : "Column"} name for ${label}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          save();
        }
        if (event.key === "Escape") {
          finished.current = true;
          setEditing(false);
        }
      }}
      autoFocus
      maxLength={128}
    />
  ) : (
    <>
      <span className="model-column-name" title={name}>
        {name}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="model-small-icon"
        aria-label={`Rename ${table ? "table" : "column"} ${name}`}
        onClick={() => {
          setValue(name);
          finished.current = false;
          setEditing(true);
        }}
      >
        <Pencil size={10} />
      </Button>
    </>
  );
}

function Column({
  column,
  name,
  reason,
  dimensions,
  location,
  aggregation,
  additivity,
  disabled,
  onMove,
  onRename,
  onAggregation,
}: {
  column: ColumnProfile;
  name: string;
  reason: string;
  dimensions: Dimension[];
  location: string;
  aggregation?: Aggregation;
  additivity?: string;
  disabled: boolean;
  onMove: (target: string) => void;
  onRename: (value: string) => void;
  onAggregation: (value: Aggregation) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: column.id,
    disabled,
  });
  const targets = dimensions.filter(
    (dimension) => dimension.generated !== "date" || column.type === "DATE",
  );
  return (
    <div
      ref={setNodeRef}
      className="draggable-column model-editable-column"
      style={{ opacity: isDragging ? 0.3 : 1 }}
    >
      <div className="model-column-main">
        <button
          type="button"
          {...listeners}
          {...attributes}
          aria-label={`Drag ${name}`}
          className="model-drag-handle"
          disabled={disabled}
        >
          <GripVertical size={12} />
        </button>
        <span className="model-column-rename mono">
          <Rename name={name} label={column.name} onRename={onRename} />
        </span>
        <Reason text={reason} label={name} />
        <span className="column-type mono" aria-hidden="true">
          {column.type === "VARCHAR"
            ? "abc"
            : column.type === "DATE"
              ? "date"
              : "123"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="model-small-icon"
              aria-label={`Move ${name} to table`}
              disabled={disabled}
            >
              <ChevronDown size={12} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label={`Move ${name} to table`}>
            <DropdownMenuRadioGroup value={location} onValueChange={onMove}>
              <DropdownMenuRadioItem value="unassigned">
                Unassigned
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="fact">
                Fact table
              </DropdownMenuRadioItem>
              {targets.map((dimension) => (
                <DropdownMenuRadioItem key={dimension.id} value={dimension.id}>
                  {dimension.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {aggregation && (
        <div className="model-measure-settings">
          <span>{additivity}</span>
          <SelectMenu
            label={`Aggregation for ${name}`}
            value={aggregation}
            options={["SUM", "AVG", "COUNT", "MIN", "MAX"].map((value) => ({
              value,
              label: value,
            }))}
            onValueChange={(value) => onAggregation(value as Aggregation)}
            style={{ height: 25, padding: "3px 7px", fontSize: 9 }}
          />
        </div>
      )}
    </div>
  );
}

function DropArea({
  id,
  children,
  className,
}: {
  id: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={cn(className, isOver && "over")}>
      {children}
    </section>
  );
}

function SchemaPreview({ model }: { model: Model }) {
  const patternId = useId().replaceAll(":", "");
  const rows = Math.max(2, Math.ceil(model.dimensions.length / 2));
  const topRows = Math.ceil(rows / 2);
  const height = Math.max(315, rows * 90 + 100);
  const centerY = topRows * 90 + 55;
  const connected = new Set(
    model.fact.foreignKeys.map((key) => key.dimensionId),
  );
  return (
    <svg
      viewBox={`0 0 300 ${height}`}
      className="schema-preview"
      style={{ height }}
      role="img"
      aria-label={`Star schema: ${model.fact.name}, ${model.fact.measures.length} measures, ${model.fact.foreignKeys.length} foreign keys and ${model.dimensions.length} dimensions`}
    >
      <defs>
        <pattern
          id={patternId}
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".6" fill="var(--line)" />
        </pattern>
      </defs>
      <rect
        width="300"
        height={height}
        style={{ fill: `url(#${patternId})`, stroke: "none" }}
      />
      {model.dimensions.map((dimension, index) => {
        const x = index % 2 === 0 ? 10 : 180;
        const row = Math.floor(index / 2);
        const y = 20 + row * 90 + (row >= topRows ? 100 : 0);
        return (
          <g key={dimension.id}>
            <title>{`${dimension.name}: business key ${model.columnNames[dimension.businessKey] || dimension.businessKey || "not set"}`}</title>
            {connected.has(dimension.id) && (
              <path d={`M150 ${centerY} V${y + 32} H${x + 50}`} />
            )}
            <rect x={x} y={y} width="110" height="58" rx="5" />
            <path d={`M${x} ${y + 24} H${x + 110}`} />
            <text x={x + 8} y={y + 16}>
              {dimension.name.length > 16
                ? `${dimension.name.slice(0, 15)}…`
                : dimension.name}
            </text>
            <text x={x + 8} y={y + 39} className="svg-muted">
              {dimension.generated === "date"
                ? "Generated calendar"
                : `${dimension.columnIds.length} source columns`}
            </text>
            <text
              x={x + 8}
              y={y + 50}
              className="svg-muted"
            >{`PK: ${(model.columnNames[dimension.businessKey] || dimension.businessKey || "not set").slice(0, 18)}`}</text>
          </g>
        );
      })}
      <rect
        x="95"
        y={centerY - 35}
        width="110"
        height="70"
        rx="5"
        style={{ stroke: "var(--muted)" }}
      />
      <rect
        x="96"
        y={centerY - 34}
        width="108"
        height="25"
        rx="4"
        className="svg-header"
        style={{ stroke: "none" }}
      />
      <text x="105" y={centerY - 18}>
        {model.fact.name.slice(0, 16)}
      </text>
      <text x="105" y={centerY + 5} className="svg-muted">
        {model.fact.measures.length} measures
      </text>
      <text x="105" y={centerY + 21} className="svg-muted">
        {model.fact.foreignKeys.length} foreign keys
      </text>
    </svg>
  );
}

type SaveStatus = "saved" | "saving" | "error";

export function ModelEditor({
  initialModel,
  initialSource = "suggested",
  columns,
  projectId,
}: {
  initialModel: Model;
  initialSource?: "suggested" | "edited";
  columns: ColumnProfile[];
  projectId: string;
}) {
  const router = useRouter();
  const [model, setModel] = useState(initialModel);
  const [source, setSource] = useState(initialSource);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const modelRef = useRef(initialModel);
  const pending = useRef<Model | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/model`;
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const issues = useMemo(() => validateModel(model, columns), [model, columns]);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const notes = issues.filter((issue) => issue.severity === "info");
  const find = (id: string) => columns.find((column) => column.id === id);

  const flush = useCallback(
    async function flushSaves(): Promise<boolean> {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (inFlight.current) {
        const success = await inFlight.current;
        return success && pending.current ? flushSaves() : success;
      }
      if (!pending.current) return true;
      const saving = (async () => {
        while (pending.current) {
          const snapshot = pending.current;
          pending.current = null;
          const body = JSON.stringify({ model: snapshot });
          try {
            const response = await fetch(endpoint, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body,
              keepalive: new TextEncoder().encode(body).byteLength <= 60_000,
            });
            const result = (await response.json().catch(() => null)) as {
              error?: string;
            } | null;
            if (!response.ok)
              throw new Error(
                result?.error || "Your model could not be saved. Try again.",
              );
          } catch (failure) {
            // A newer edit takes precedence over the snapshot that failed.
            pending.current ??= snapshot;
            setSaveStatus("error");
            setError(
              failure instanceof Error
                ? failure.message
                : "The server could not be reached. Try again.",
            );
            return false;
          }
        }
        setSource("edited");
        setSaveStatus("saved");
        setError("");
        return true;
      })();
      inFlight.current = saving;
      try {
        return await saving;
      } finally {
        inFlight.current = null;
      }
    },
    [endpoint],
  );

  function edit(action: ModelAction) {
    if (busyRef.current) return;
    const next = modelReducer(modelRef.current, action);
    if (next === modelRef.current) return;
    modelRef.current = next;
    setModel(next);
    pending.current = next;
    setSaveStatus("saving");
    setError("");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 500);
  }

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (pending.current || inFlight.current) {
        void flush();
        event.preventDefault();
      }
    }
    function navigate(event: MouseEvent) {
      if (!pending.current && !inFlight.current) return;
      const anchor =
        event.target instanceof Element ? event.target.closest("a") : null;
      if (
        !anchor ||
        anchor.target === "_blank" ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const url = new URL(anchor.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname === window.location.pathname
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void flush().then((success) => {
        if (success) router.push(`${url.pathname}${url.search}${url.hash}`);
      });
    }
    const pageHide = () => void flush();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("click", navigate, true);
      if (timer.current) clearTimeout(timer.current);
      void flush();
    };
  }, [flush, router]);

  useEffect(() => {
    if (confirming && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    else if (!confirming) dialog.current?.close();
  }, [confirming]);

  async function regenerate() {
    if (busyRef.current) return;
    busyRef.current = true;
    setRegenerating(true);
    try {
      if (!(await flush())) return;
      const response = await fetch(`${endpoint}/suggest`, { method: "POST" });
      const result = (await response.json()) as {
        model?: Model;
        error?: string;
      };
      if (!response.ok || !result.model)
        throw new Error(
          result.error || "The model could not be regenerated. Try again.",
        );
      pending.current = null;
      modelRef.current = result.model;
      setModel(result.model);
      setSource("suggested");
      setSaveStatus("saved");
      setError("");
      setConfirming(false);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The server could not be reached. Try again.",
      );
    } finally {
      busyRef.current = false;
      setRegenerating(false);
    }
  }

  const columnNodes = (ids: string[], location: string) =>
    ids.map((id) => {
      const column = find(id);
      if (!column) return null;
      const measure = model.fact.measures.find((item) => item.columnId === id);
      return (
        <Column
          key={id}
          column={column}
          name={model.columnNames[id] || column.name}
          reason={model.reasons[id] || measure?.reason || "Assigned by you."}
          location={location}
          dimensions={model.dimensions}
          aggregation={location === "fact" ? measure?.aggregation : undefined}
          additivity={measure?.additivity}
          disabled={regenerating}
          onMove={(target) =>
            edit({ type: "move", column: id, target, columnType: column.type })
          }
          onRename={(name) => edit({ type: "rename-column", column: id, name })}
          onAggregation={(aggregation) =>
            edit({ type: "aggregation", column: id, aggregation })
          }
        />
      );
    });

  function onDragEnd(event: DragEndEvent) {
    setActive(null);
    const column = find(String(event.active.id));
    if (event.over && column)
      edit({
        type: "move",
        column: column.id,
        target: String(event.over.id),
        columnType: column.type,
      });
  }
  const factIds = [
    ...model.fact.measures.map((item) => item.columnId),
    ...model.fact.degenerateDimensions.map((item) => item.columnId),
  ];
  const assigned = new Set([
    ...factIds,
    ...model.dimensions.flatMap((dimension) => dimension.columnIds),
  ]);

  return (
    <>
      <fieldset disabled={regenerating} className="model-editor-fields">
        <div className="toolbar">
          <div className="toolbar-left">
            <span
              className={cn(
                "status-dot",
                errors.length + warnings.length > 0 && "warning",
              )}
            />
            <span className="small muted">
              {model.unassigned.length
                ? `${model.unassigned.length} columns waiting for a home`
                : "All columns assigned"}
            </span>
          </div>
          <div className="toolbar-right">
            <span
              className={cn(
                "model-save-status",
                saveStatus === "error" && "inline-error",
              )}
              role="status"
              aria-live="polite"
            >
              {saveStatus === "saving" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : saveStatus === "saved" ? (
                <Check size={12} />
              ) : (
                <AlertTriangle size={12} />
              )}
              {saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "saved"
                  ? "Saved"
                  : "Not saved"}
            </span>
            <Button
              variant="ghost"
              onClick={() => edit({ type: "replace", model: initialModel })}
            >
              <Undo2 size={12} />
              Reset
            </Button>
            <Button variant="outline" onClick={() => setConfirming(true)}>
              <WandSparkles size={14} />
              Suggested model
            </Button>
          </div>
        </div>
        {error && saveStatus === "error" && (
          <div className="model-save-error" role="alert">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSaveStatus("saving");
                void flush();
              }}
            >
              Retry save
            </Button>
          </div>
        )}
        <DndContext
          id={dndId}
          sensors={sensors}
          onDragStart={(event) => setActive(String(event.active.id))}
          onDragCancel={() => setActive(null)}
          onDragEnd={onDragEnd}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "To pick up a column, press Space. Use arrow keys to move and Space to drop. Escape cancels. Each column also has a move menu.",
            },
          }}
        >
          <div className="model-layout">
            <div>
              <DropArea id="unassigned" className="model-pane">
                <div className="model-pane-heading">
                  Source columns{" "}
                  <span className="count mono">{model.unassigned.length}</span>
                </div>
                <div className="column-list">
                  {model.unassigned.length ? (
                    columnNodes(model.unassigned, "unassigned")
                  ) : (
                    <div
                      className="empty-state"
                      style={{ padding: "35px 12px", gridColumn: "1/-1" }}
                    >
                      <Check size={20} />
                      <span className="small">Everything has a home.</span>
                    </div>
                  )}
                </div>
                <p className="column-help">
                  Drag columns into a table, or use a column’s menu to move it.
                  Drop columns here to unassign them.
                </p>
              </DropArea>
              <div className="model-hint" style={{ marginTop: 12 }}>
                <Info
                  size={12}
                  style={{
                    display: "inline",
                    verticalAlign: "middle",
                    marginRight: 5,
                  }}
                />{" "}
                Suggestions use your profiles and observed value relationships.
                Hover or focus an info icon to see the reason.
              </div>
            </div>
            <div className="model-center">
              <DropArea id="fact" className="model-card">
                <div className="model-card-head">
                  <div className="model-card-title">
                    <Table2 size={14} />
                    <Rename
                      table
                      name={model.fact.name}
                      label={model.fact.name}
                      onRename={(name) =>
                        edit({ type: "rename", id: "fact", name })
                      }
                    />
                    <Reason text={model.fact.reason} label={model.fact.name} />
                  </div>
                  <span className="key-badge">FACT</span>
                </div>
                <div className="model-card-body">
                  <label className="model-grain">
                    <span>Grain</span>
                    <input
                      aria-label="Fact table grain"
                      value={model.fact.grain}
                      maxLength={2000}
                      onChange={(event) =>
                        edit({ type: "grain", value: event.target.value })
                      }
                    />
                  </label>
                  <div className="model-subtitle">
                    Measures <span>{model.fact.measures.length}</span>
                  </div>
                  {columnNodes(
                    model.fact.measures.map((item) => item.columnId),
                    "fact",
                  )}
                  {!model.fact.measures.length && (
                    <div className="drop-placeholder">
                      Drop measure columns here
                    </div>
                  )}
                  <div className="model-subtitle">
                    Degenerate dimensions{" "}
                    <span>{model.fact.degenerateDimensions.length}</span>
                  </div>
                  {columnNodes(
                    model.fact.degenerateDimensions.map(
                      (item) => item.columnId,
                    ),
                    "fact",
                  )}
                  <div className="model-subtitle">
                    Foreign keys <span>{model.fact.foreignKeys.length}</span>
                  </div>
                  {model.fact.foreignKeys.map((key, index) => (
                    <div
                      key={`${key.dimensionId}-${key.sourceColumnId}-${index}`}
                      className="model-foreign-key"
                    >
                      <KeyRound size={10} />
                      <span className="mono">{key.name}</span>
                      <Reason text={key.reason} label={key.name} />
                      <span className="model-foreign-target">
                        →{" "}
                        {model.dimensions.find(
                          (dimension) => dimension.id === key.dimensionId,
                        )?.name || "Missing dimension"}
                      </span>
                    </div>
                  ))}
                </div>
              </DropArea>
              <div className="dimension-label">
                <span>
                  DIMENSIONS{" "}
                  <span className="mono">({model.dimensions.length})</span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => edit({ type: "add", id: crypto.randomUUID() })}
                >
                  <Plus size={12} />
                  Add dimension
                </Button>
              </div>
              {model.dimensions.map((dimension) => (
                <DropArea
                  key={dimension.id}
                  id={dimension.id}
                  className="model-card"
                >
                  <div className="model-card-head">
                    <div className="model-card-title">
                      <Table2 size={14} />
                      <Rename
                        table
                        name={dimension.name}
                        label={dimension.name}
                        onRename={(name) =>
                          edit({ type: "rename", id: dimension.id, name })
                        }
                      />
                      <Reason text={dimension.reason} label={dimension.name} />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="model-small-icon"
                      aria-label={`Remove ${dimension.name}`}
                      onClick={() => edit({ type: "remove", id: dimension.id })}
                    >
                      <X size={12} />
                    </Button>
                  </div>
                  <div className="model-card-body">
                    <div className="model-grain">
                      <KeyRound size={11} />
                      <span>Business key</span>
                      {dimension.generated === "date" ? (
                        <span className="mono">DateKey (generated)</span>
                      ) : (
                        <SelectMenu
                          label={`Business key for ${dimension.name}`}
                          value={dimension.businessKey}
                          options={[
                            { value: "", label: "Select column" },
                            ...dimension.columnIds.map((id) => ({
                              value: id,
                              label:
                                model.columnNames[id] || find(id)?.name || id,
                            })),
                          ]}
                          onValueChange={(column) =>
                            edit({ type: "key", id: dimension.id, column })
                          }
                          style={{
                            height: 28,
                            padding: "4px 7px",
                            fontSize: 10,
                            flex: 1,
                            minWidth: 0,
                          }}
                        />
                      )}
                    </div>
                    {dimension.generated === "date" && (
                      <div className="model-calendar">
                        <span className="small muted">
                          Generated calendar attributes
                        </span>
                        <span className="mono">
                          {dimension.attributes.join(" · ")}
                        </span>
                      </div>
                    )}
                    <div className="model-subtitle">
                      {dimension.generated === "date"
                        ? "Source date columns"
                        : "Source columns"}
                      <span>{dimension.columnIds.length}</span>
                    </div>
                    {columnNodes(dimension.columnIds, dimension.id)}
                    {!dimension.columnIds.length && (
                      <div className="drop-placeholder">
                        Drop dimension attributes here
                      </div>
                    )}
                  </div>
                </DropArea>
              ))}
            </div>
            <aside className="model-pane model-preview-pane">
              <div className="model-pane-heading">
                Star schema <span className="count">Live preview</span>
              </div>
              <div className="model-schema-scroll">
                <SchemaPreview model={model} />
              </div>
              <div className="schema-info">
                <div className="detail-row">
                  <span>Fact tables</span>
                  <span className="mono">1</span>
                </div>
                <div className="detail-row">
                  <span>Dimensions</span>
                  <span className="mono">{model.dimensions.length}</span>
                </div>
                <div className="detail-row">
                  <span>Assigned columns</span>
                  <span className="mono">
                    {assigned.size} / {columns.length}
                  </span>
                </div>
                <p style={{ marginTop: 12 }}>
                  Dimension keys link to the fact table.{" "}
                  {source === "suggested"
                    ? "Review the suggested grain and assignments."
                    : "Your edits are saved to this project."}
                </p>
              </div>
              <section
                className="model-validation"
                aria-labelledby="model-validation-title"
              >
                <h2 id="model-validation-title">
                  Validation{" "}
                  <span className="count">
                    {errors.length} errors · {warnings.length} warnings
                    {notes.length > 0 && ` · ${notes.length} ${notes.length === 1 ? "note" : "notes"}`}
                  </span>
                </h2>
                {issues.length ? (
                  <ul>
                    {issues.map((issue, index) => (
                      <li
                        key={`${issue.code}-${index}`}
                        className={
                          issue.severity === "error"
                            ? "model-validation-error"
                            : issue.severity === "warning"
                              ? "model-validation-warning"
                              : "muted"
                        }
                      >
                        <span className="sr-only">{issue.severity}: </span>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    <Check size={12} /> No issues found.
                  </p>
                )}
                {model.warnings.some((warning) =>
                  /duplicat/i.test(warning),
                ) && (
                  <label className="model-duplicate-option">
                    <input
                      type="checkbox"
                      checked={model.removeExactDuplicates}
                      onChange={(event) =>
                        edit({
                          type: "duplicates",
                          value: event.target.checked,
                        })
                      }
                    />
                    <span>Remove exact duplicates</span>
                  </label>
                )}
              </section>
            </aside>
          </div>
          <DragOverlay>
            {active && find(active) ? (
              <div
                className="draggable-column mono"
                style={{
                  borderColor: "var(--muted)",
                  cursor: "grabbing",
                  padding: 10,
                }}
              >
                <GripVertical size={12} />
                {model.columnNames[active] || find(active)?.name}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
        <div className="model-bottom">
          <span className="model-message">
            Edits save automatically. Validation issues can be resolved as you
            work.
          </span>
          <Link
            href={`/projects/${projectId}/generate`}
            className={buttonVariants()}
          >
            Continue to SQL preview
            <ArrowRight size={14} />
          </Link>
        </div>
      </fieldset>
      <dialog
        ref={dialog}
        className="model-confirm-dialog"
        aria-labelledby="regenerate-model-title"
        onCancel={(event) => {
          if (regenerating) event.preventDefault();
          else setConfirming(false);
        }}
      >
        <h2 id="regenerate-model-title">Replace this model?</h2>
        <p>
          Regenerating a suggested model will replace your saved assignments,
          names, grain, and other edits. Your source data will stay available.
        </p>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="model-dialog-actions">
          <Button
            variant="outline"
            autoFocus
            disabled={regenerating}
            onClick={() => setConfirming(false)}
          >
            Keep editing
          </Button>
          <Button disabled={regenerating} onClick={() => void regenerate()}>
            {regenerating ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <WandSparkles size={13} />
            )}
            {regenerating ? "Regenerating…" : "Replace with suggestion"}
          </Button>
        </div>
      </dialog>
    </>
  );
}
