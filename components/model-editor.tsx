"use client";
import { useReducer, useState, useId } from "react";
import Link from "next/link";
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
} from "lucide-react";
import type { Model, ColumnProfile, Dimension } from "@/lib/types";
import { Button, buttonVariants } from "./ui/button";
import { cn } from "@/lib/utils";
type Action =
  | { type: "move"; column: string; target: string }
  | { type: "suggest"; model: Model }
  | { type: "reset"; model: Model }
  | { type: "add"; id: string }
  | { type: "rename"; id: string; name: string }
  | { type: "grain"; value: string }
  | { type: "key"; id: string; column: string }
  | { type: "remove"; id: string };
function reducer(state: Model, action: Action): Model {
  switch (action.type) {
    case "move": {
      if (
        (action.target === "fact" &&
          state.fact.columnIds.includes(action.column)) ||
        (action.target === "unassigned" &&
          state.unassigned.includes(action.column)) ||
        state.dimensions.some(
          (d) => d.id === action.target && d.columnIds.includes(action.column),
        )
      )
        return state;
      const next: Model = {
        fact: {
          ...state.fact,
          columnIds: state.fact.columnIds.filter((c) => c !== action.column),
        },
        dimensions: state.dimensions.map((d) => ({
          ...d,
          columnIds: d.columnIds.filter((c) => c !== action.column),
          businessKey: d.businessKey === action.column ? "" : d.businessKey,
        })),
        unassigned: state.unassigned.filter((c) => c !== action.column),
      };
      if (action.target === "fact") next.fact.columnIds.push(action.column);
      else if (action.target === "unassigned")
        next.unassigned.push(action.column);
      else
        next.dimensions = next.dimensions.map((d) =>
          d.id === action.target
            ? {
                ...d,
                columnIds: [...d.columnIds, action.column],
                businessKey: d.businessKey || action.column,
              }
            : d,
        );
      return next;
    }
    case "suggest":
    case "reset":
      return structuredClone(action.model);
    case "add":
      return {
        ...state,
        dimensions: [
          ...state.dimensions,
          {
            id: action.id,
            name: `dim_custom_${state.dimensions.length + 1}`,
            columnIds: [],
            businessKey: "",
          },
        ],
      };
    case "rename":
      return action.id === "fact"
        ? { ...state, fact: { ...state.fact, name: action.name } }
        : {
            ...state,
            dimensions: state.dimensions.map((d) =>
              d.id === action.id ? { ...d, name: action.name } : d,
            ),
          };
    case "grain":
      return { ...state, fact: { ...state.fact, grain: action.value } };
    case "key":
      return {
        ...state,
        dimensions: state.dimensions.map((d) =>
          d.id === action.id ? { ...d, businessKey: action.column } : d,
        ),
      };
    case "remove":
      return {
        ...state,
        dimensions: state.dimensions.filter((d) => d.id !== action.id),
        unassigned: [
          ...state.unassigned,
          ...(state.dimensions.find((d) => d.id === action.id)?.columnIds ??
            []),
        ],
      };
  }
}
function Column({
  column,
  dimensions,
  location,
  onMove,
}: {
  column: ColumnProfile;
  dimensions: Dimension[];
  location: string;
  onMove: (target: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: column.id,
  });
  return (
    <div
      ref={setNodeRef}
      className="draggable-column"
      style={{ opacity: isDragging ? 0.3 : 1 }}
    >
      <button {...listeners} {...attributes} aria-label={`Drag ${column.name}`}>
        <GripVertical size={11} />
        <span
          className="mono"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {column.name}
        </span>
      </button>
      <span className="column-type mono" aria-hidden="true">
        {column.type === "VARCHAR"
          ? "abc"
          : column.type === "DATE"
            ? "date"
            : "123"}
      </span>

      <label
        style={{
          position: "relative",
          display: "flex",
          color: "var(--muted)",
          width: 16,
        }}
      >
        <ChevronDown size={12} />
        <select
          aria-label={`Move ${column.name} to table`}
          value={location}
          onChange={(e) => onMove(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0,
            width: 20,
            padding: 0,
          }}
        >
          <option value="unassigned">Unassigned</option>
          <option value="fact">Fact table</option>
          {dimensions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
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
function RenameTitle({
  id,
  name,
  onRename,
}: {
  id: string;
  name: string;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  function save() {
    const next = value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
    if (next) onRename(next);
    else setValue(name);
    setEditing(false);
  }
  return (
    <div className="model-card-title">
      <Table2 size={14} />
      {editing ? (
        <input
          className="rename-input"
          aria-label="Table name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setValue(name);
              setEditing(false);
            }
          }}
          autoFocus
          maxLength={40}
        />
      ) : (
        <>
          <span>{name}</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setValue(name);
              setEditing(true);
            }}
            aria-label={`Rename ${name}`}
            style={{ width: 22, height: 22, minHeight: 22 }}
          >
            <Pencil size={10} />
          </Button>
        </>
      )}
      <span className="sr-only">{id}</span>
    </div>
  );
}
function SchemaPreview({ model }: { model: Model }) {
  const spots = [
    [15, 25],
    [175, 25],
    [15, 235],
    [175, 235],
    [15, 130],
    [175, 130],
  ];
  return (
    <svg
      viewBox="0 0 300 315"
      className="schema-preview"
      role="img"
      aria-label={`Star schema: ${model.fact.name} connected to ${model.dimensions.length} dimensions`}
    >
      <defs>
        <pattern
          id="schema-dots"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".6" fill="var(--line)" />
        </pattern>
      </defs>
      <rect
        width="300"
        height="315"
        style={{ fill: "url(#schema-dots)", stroke: "none" }}
      />
      {model.dimensions.map((d, i) => {
        const [x, y] = spots[i];
        return (
          <g key={d.id}>
            <path d={`M150 160 V${y + 34} H${x + 50}`} />
            <circle cx={150} cy={160} r="2" fill="var(--muted)" />
            <rect x={x} y={y} width="110" height="56" rx="5" />
            <path d={`M${x} ${y + 24} H${x + 110}`} />
            <text x={x + 9} y={y + 16}>
              {d.name.length > 16 ? d.name.slice(0, 15) + "…" : d.name}
            </text>
            <text x={x + 9} y={y + 39} className="svg-muted">
              {d.columnIds.length} attributes · PK
            </text>
          </g>
        );
      })}
      <rect
        x="95"
        y="125"
        width="110"
        height="70"
        rx="5"
        style={{ stroke: "var(--muted)" }}
      />
      <rect
        x="96"
        y="126"
        width="108"
        height="25"
        rx="4"
        className="svg-header"
        style={{ stroke: "none" }}
      />
      <text x="105" y="142">
        {model.fact.name.slice(0, 16)}
      </text>
      <text x="105" y="165" className="svg-muted">
        {model.fact.columnIds.length} columns
      </text>
      <text x="105" y="181" className="svg-muted">
        {model.dimensions.length} foreign keys
      </text>
    </svg>
  );
}
export function ModelEditor({
  initialModel,
  suggestedModel,
  columns,
  projectId,
}: {
  initialModel: Model;
  suggestedModel: Model;
  columns: ColumnProfile[];
  projectId: string;
}) {
  const [model, dispatch] = useReducer(reducer, initialModel);
  const [active, setActive] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [counter, setCounter] = useState(0);
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );
  const find = (id: string) => columns.find((c) => c.id === id)!;
  const move = (column: string, target: string) => {
    dispatch({ type: "move", column, target });
    setMessage("Model updated. Changes stay in this preview.");
  };
  function onDragEnd(event: DragEndEvent) {
    setActive(null);
    if (event.over) move(String(event.active.id), String(event.over.id));
  }
  const columnNodes = (ids: string[], location: string) =>
    ids.map((id) => (
      <Column
        key={id}
        column={find(id)}
        location={location}
        dimensions={model.dimensions}
        onMove={(target) => move(id, target)}
      />
    ));
  return (
    <>
      <div className="toolbar">
        <div className="toolbar-left">
          <span className="status-dot warning" />
          <span className="small muted">
            {model.unassigned.length
              ? `${model.unassigned.length} columns waiting for a home`
              : "All columns assigned"}
          </span>
        </div>
        <div className="toolbar-right">
          <Button
            variant="ghost"
            onClick={() => {
              dispatch({ type: "reset", model: initialModel });
              setMessage("Model reset to its starting point.");
            }}
          >
            <Undo2 size={12} />
            Reset
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              dispatch({ type: "suggest", model: suggestedModel });
              setMessage("Suggested model applied. Review and make it yours.");
            }}
          >
            <WandSparkles size={14} />
            Suggested model
          </Button>
        </div>
      </div>
      <DndContext
        id={dndId}
        sensors={sensors}
        onDragStart={(e) => setActive(String(e.active.id))}
        onDragCancel={() => setActive(null)}
        onDragEnd={onDragEnd}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              "To pick up a column, press Space. Use the arrow keys to move it, then press Space to drop. Press Escape to cancel. You can also use the move column menu next to each column.",
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
              >
                <title>Tip</title>
              </Info>
              Start with a suggested model, then refine it to fit the questions
              you want to answer.
            </div>
          </div>
          <div className="model-center">
            <DropArea id="fact" className="model-card">
              <div className="model-card-head">
                <RenameTitle
                  id="fact"
                  name={model.fact.name}
                  onRename={(name) =>
                    dispatch({ type: "rename", id: "fact", name })
                  }
                />
                <span className="key-badge">FACT</span>
              </div>
              <div className="model-card-body">
                <label className="model-grain">
                  <span>Grain</span>
                  <input
                    aria-label="Fact table grain"
                    value={model.fact.grain}
                    onChange={(e) =>
                      dispatch({ type: "grain", value: e.target.value })
                    }
                  />
                </label>
                <div className="model-subtitle">
                  Measures & identifiers{" "}
                  <span>{model.fact.columnIds.length}</span>
                </div>
                {columnNodes(model.fact.columnIds, "fact")}
                {!model.fact.columnIds.length && (
                  <div className="drop-placeholder">
                    Drop measure columns here
                  </div>
                )}
                <div className="model-subtitle">
                  Foreign keys <span>{model.dimensions.length}</span>
                </div>
                {model.dimensions.map((d) => (
                  <div
                    key={d.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      color: "var(--muted)",
                      fontSize: 10,
                      padding: "4px 2px",
                    }}
                  >
                    <KeyRound size={10} />
                    <span className="mono">
                      {d.name.replace(/^dim_/, "")}_key
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 9 }}>
                      → {d.name}
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
                disabled={model.dimensions.length >= 6}
                onClick={() => {
                  dispatch({ type: "add", id: `custom-${counter}` });
                  setCounter((c) => c + 1);
                }}
              >
                <Plus size={12} />
                Add dimension
              </Button>
            </div>
            {model.dimensions.map((d) => (
              <DropArea key={d.id} id={d.id} className="model-card">
                <div className="model-card-head">
                  <RenameTitle
                    id={d.id}
                    name={d.name}
                    onRename={(name) =>
                      dispatch({ type: "rename", id: d.id, name })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => dispatch({ type: "remove", id: d.id })}
                    style={{ width: 22, height: 22, minHeight: 22 }}
                  >
                    <X size={12} />
                  </Button>
                </div>
                <div className="model-card-body">
                  <label className="model-grain">
                    <KeyRound size={11} />
                    <span>Business key</span>
                    <select
                      aria-label={`Business key for ${d.name}`}
                      value={d.businessKey}
                      onChange={(e) =>
                        dispatch({
                          type: "key",
                          id: d.id,
                          column: e.target.value,
                        })
                      }
                      style={{ padding: "4px 7px", fontSize: 10, flex: 1 }}
                    >
                      <option value="">Select column</option>
                      {d.columnIds.map((c) => (
                        <option key={c} value={c}>
                          {find(c).name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="model-subtitle">
                    Attributes <span>{d.columnIds.length}</span>
                  </div>
                  {columnNodes(d.columnIds, d.id)}
                  {!d.columnIds.length && (
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
            <SchemaPreview model={model} />
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
                  {columns.length - model.unassigned.length} / {columns.length}
                </span>
              </div>
              <p style={{ marginTop: 12 }}>
                Dimension surrogate keys link to the fact table. Your preview
                updates as you model.
              </p>
            </div>
          </aside>
        </div>
        <DragOverlay>
          {active ? (
            <div
              className="draggable-column mono"
              style={{
                borderColor: "var(--muted)",
                cursor: "grabbing",
                padding: 10,
              }}
            >
              <GripVertical size={12} />
              {find(active).name}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="model-bottom">
        <span className="model-message" role="status">
          {message ||
            "Your model, your call. All changes are local to this screen."}
        </span>
        <Link
          href={`/projects/${projectId}/generate`}
          className={buttonVariants()}
        >
          Continue to SQL preview
          <ArrowRight size={14} />
        </Link>
      </div>
    </>
  );
}
