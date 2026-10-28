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
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Database,
  Folder,
  GitBranch,
  Info,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sigma,
  Trash2,
  X,
} from "lucide-react";
import type {
  MeasureFormat,
  SemanticMeasure,
  SemanticModel,
  SqlParameter,
} from "@/lib/semantic/types";
import type {
  AttributeRef,
  QueryResult,
  QueryTimings,
  QueryValue,
} from "@/lib/semantic/query/types";
import { Button } from "./ui/button";
import { SelectMenu } from "./select-menu";
import styles from "./measures-workspace.module.css";

interface ExpressionValidation {
  ok: boolean;
  astSummary?: unknown;
  sql?: string;
  params?: SqlParameter[];
  errors: { message: string; position?: number }[];
}
type Confirmation =
  | { kind: "delete" | "regenerate" }
  | { kind: "select"; measureId: string | null };
interface QueryFailureDiagnostics {
  timings: QueryTimings;
  sql?: string;
  params?: SqlParameter[];
}

class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly diagnostics?: QueryFailureDiagnostics,
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error || "The request could not be completed. Try again.",
      response.status,
      body?.timings && typeof body.timings === "object"
        ? {
            timings: body.timings,
            ...(typeof body.sql === "string" ? { sql: body.sql } : {}),
            ...(Array.isArray(body.params) ? { params: body.params } : {}),
          }
        : undefined,
    );
  return body as T;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Try again.";
}

function newMeasure(): SemanticMeasure {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "",
    expression: "",
    format: "number",
    folder: "Custom",
    description: "",
    isAuto: false,
    createdAt: now,
    updatedAt: now,
  };
}

function displayValue(value: QueryValue, format?: MeasureFormat): string {
  if (value === null) return "—";
  if (typeof value === "number") {
    if (format === "currency")
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
    if (format === "percent")
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 2,
      }).format(value);
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: format === "decimals" ? 2 : 4,
      ...(format === "decimals" ? { minimumFractionDigits: 2 } : {}),
    }).format(value);
  }
  return typeof value === "boolean" ? (value ? "True" : "False") : value;
}

export function MeasuresWorkspace({ projectId }: { projectId: string }) {
  const id = useId();
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/semantic`;
  const queryEndpoint = `/api/projects/${encodeURIComponent(projectId)}/query`;
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [draft, setDraft] = useState<SemanticMeasure | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ExpressionValidation | null>(
    null,
  );
  const [validationError, setValidationError] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selectedMeasures, setSelectedMeasures] = useState<string[]>([]);
  const [selectedAttributes, setSelectedAttributes] = useState<string[]>([]);
  const [hideUnknown, setHideUnknown] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState("");
  const [queryDiagnostics, setQueryDiagnostics] =
    useState<QueryFailureDiagnostics | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<QueryResult | null>(null);
  const [testError, setTestError] = useState("");
  const [testDiagnostics, setTestDiagnostics] =
    useState<QueryFailureDiagnostics | null>(null);
  const [queryStatisticsRequested, setQueryStatisticsRequested] =
    useState(false);
  const [testStatisticsRequested, setTestStatisticsRequested] = useState(false);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const validationVersion = useRef(0);
  const queryRequest = useRef<AbortController | null>(null);
  const testRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const expressionInput = useRef<HTMLTextAreaElement>(null);
  const savedDraft = model?.measures.find(
    (measure) => measure.id === draft?.id,
  );
  const dirty = Boolean(
    draft &&
    (!savedDraft || JSON.stringify(draft) !== JSON.stringify(savedDraft)),
  );

  const applyModel = useCallback((next: SemanticModel, selectedId?: string) => {
    setModel(next);
    setDraft(
      next.measures.find((measure) => measure.id === selectedId) ??
        next.measures[0] ??
        null,
    );
    setValidation(null);
    setValidationError("");
    setValidating(false);
    setTestResult(null);
    setTestError("");
    setTestDiagnostics(null);
    setQueryError("");
    setQueryDiagnostics(null);
    setSelectedMeasures((current) => {
      const retained = current.filter((item) =>
        next.measures.some((measure) => measure.id === item),
      );
      return retained.length
        ? retained
        : next.measures.slice(0, 1).map((measure) => measure.id);
    });
    setSelectedAttributes((current) =>
      current.filter((columnId) =>
        next.tables.some((table) =>
          table.columns.some((column) => column.id === columnId),
        ),
      ),
    );
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await requestJson<SemanticModel>(endpoint, { signal });
        if (mounted.current && !signal?.aborted) {
          applyModel(next);
          setLoadError("");
          setBlocked(false);
        }
      } catch (cause) {
        if (!signal?.aborted && mounted.current) {
          setLoadError(message(cause));
          setBlocked(cause instanceof ApiError && cause.status === 409);
        }
      } finally {
        if (!signal?.aborted && mounted.current) setLoading(false);
      }
    },
    [applyModel, endpoint],
  );

  const abortQueries = useCallback(() => {
    queryRequest.current?.abort();
    testRequest.current?.abort();
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      controller.abort();
      abortQueries();
    };
  }, [abortQueries, load]);

  useEffect(() => {
    if (!draft?.expression.trim()) return;
    const controller = new AbortController();
    const version = ++validationVersion.current;
    const timer = setTimeout(async () => {
      setValidating(true);
      try {
        const next = await requestJson<ExpressionValidation>(
          `${endpoint}/measures/validate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ expression: draft.expression }),
            signal: controller.signal,
          },
        );
        if (
          version === validationVersion.current &&
          !controller.signal.aborted
        ) {
          setValidation(next);
          setValidationError("");
        }
      } catch (cause) {
        if (version === validationVersion.current && !controller.signal.aborted)
          setValidationError(message(cause));
      } finally {
        if (version === validationVersion.current && !controller.signal.aborted)
          setValidating(false);
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft?.expression, draft?.id, endpoint, model?.version]);

  useEffect(() => {
    const dialog = confirmDialog.current;
    if (confirmation && !dialog?.open) dialog?.showModal();
    if (!confirmation && dialog?.open) dialog.close();
  }, [confirmation]);

  const grouped = useMemo(() => {
    const folders = new Map<string, SemanticMeasure[]>();
    for (const measure of model?.measures ?? []) {
      const folder = measure.folder || "General";
      const list = folders.get(folder) ?? [];
      list.push(measure);
      folders.set(folder, list);
    }
    return [...folders.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [model]);

  const attributes = useMemo(
    () =>
      (model?.tables ?? []).flatMap((table) =>
        table.columns
          .filter((column) => column.role === "attribute")
          .map((column) => ({
            id: column.id,
            table: table.id,
            label: `${table.name} · ${column.name}`,
          })),
      ),
    [model],
  );

  function edit<K extends keyof SemanticMeasure>(
    key: K,
    value: SemanticMeasure[K],
  ) {
    setDraft((current) =>
      current ? { ...current, [key]: value, isAuto: false } : current,
    );
    setNotice("");
    setError("");
    setTestResult(null);
    setTestError("");
    setTestDiagnostics(null);
    if (key === "expression") {
      ++validationVersion.current;
      setValidation(null);
      setValidationError("");
      setValidating(false);
    }
  }

  function selectMeasure(measureId: string | null) {
    if (dirty) {
      setConfirmation({ kind: "select", measureId });
      return;
    }
    openMeasure(measureId);
  }

  function openMeasure(measureId: string | null) {
    testRequest.current?.abort();
    setTesting(false);
    setDraft(
      measureId === null
        ? newMeasure()
        : (model?.measures.find((measure) => measure.id === measureId) ?? null),
    );
    setError("");
    setNotice("");
    setValidation(null);
    setValidationError("");
    setValidating(false);
    setTestResult(null);
    setTestError("");
    setTestDiagnostics(null);
    ++validationVersion.current;
  }

  async function persist(measures: SemanticMeasure[], selectedId?: string) {
    if (!model || saving) return;
    queryRequest.current?.abort();
    testRequest.current?.abort();
    setQuerying(false);
    setTesting(false);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await requestJson<SemanticModel>(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          measures,
          hierarchies: model.hierarchies,
          version: model.version,
        }),
      });
      if (mounted.current) {
        applyModel(next, selectedId);
        setNotice("Changes saved.");
        setQueryResult(null);
      }
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function save() {
    if (!model || !draft || !draft.name.trim() || !validation?.ok || saving)
      return;
    const next = {
      ...draft,
      name: draft.name.trim(),
      updatedAt: new Date().toISOString(),
    };
    const measures = savedDraft
      ? model.measures.map((measure) =>
          measure.id === draft.id ? next : measure,
        )
      : [...model.measures, next];
    void persist(measures, draft.id);
  }

  async function regenerate() {
    if (saving) return;
    queryRequest.current?.abort();
    testRequest.current?.abort();
    setQuerying(false);
    setTesting(false);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = await requestJson<SemanticModel>(`${endpoint}/regenerate`, {
        method: "POST",
      });
      if (mounted.current) {
        applyModel(next, draft?.id);
        setQueryResult(null);
        setNotice("Defaults regenerated. Custom measures were preserved.");
      }
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function confirmAction() {
    const action = confirmation;
    setConfirmation(null);
    if (action?.kind === "select") openMeasure(action.measureId);
    else if (action?.kind === "regenerate") void regenerate();
    else if (action?.kind === "delete" && draft && model) {
      if (!savedDraft) openMeasure(model.measures[0]?.id ?? null);
      else
        void persist(
          model.measures.filter((measure) => measure.id !== draft.id),
        );
    }
  }

  async function runQuery(test: boolean, diagnostics = false) {
    if (
      !model ||
      saving ||
      (test
        ? testing || dirty || !savedDraft
        : querying || !selectedMeasures.length)
    )
      return;
    const controller = new AbortController();
    const target = test ? testRequest : queryRequest;
    target.current?.abort();
    target.current = controller;
    if (test) {
      setTestStatisticsRequested(diagnostics);
      setTesting(true);
      setTestError("");
      setTestDiagnostics(null);
      setTestResult(null);
    } else {
      setQueryStatisticsRequested(diagnostics);
      setQuerying(true);
      setQueryError("");
      setQueryDiagnostics(null);
      setQueryResult(null);
    }
    const rows: AttributeRef[] = test
      ? []
      : selectedAttributes.flatMap((columnId) => {
          const attribute = attributes.find((item) => item.id === columnId);
          return attribute
            ? [{ table: attribute.table, column: attribute.id }]
            : [];
        });
    try {
      const result = await requestJson<QueryResult>(queryEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          measures: test ? [savedDraft!.id] : selectedMeasures,
          rows,
          filters: [],
          orderBy: [],
          limit: 1000,
          hideUnknown,
          ...(diagnostics ? { diagnostics: true } : {}),
        }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted && mounted.current) {
        if (test) setTestResult(result);
        else setQueryResult(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        const diagnostics =
          cause instanceof ApiError ? cause.diagnostics : null;
        if (test) {
          setTestError(message(cause));
          setTestDiagnostics(diagnostics ?? null);
        } else {
          setQueryError(message(cause));
          setQueryDiagnostics(diagnostics ?? null);
        }
      }
    } finally {
      if (!controller.signal.aborted && mounted.current) {
        if (test) setTesting(false);
        else setQuerying(false);
      }
    }
  }

  function cancelQuery() {
    queryRequest.current?.abort();
    setQuerying(false);
    setQueryError("Query cancelled.");
    setQueryDiagnostics(null);
  }

  if (loading && !model)
    return (
      <div className={styles.loading} role="status">
        <Loader2 size={18} className="animate-spin" /> Loading measures…
      </div>
    );
  if (!model)
    return (
      <section
        className={styles.prerequisite}
        aria-labelledby={`${id}-ready-title`}
      >
        <div className={styles.emptyIcon}>
          <Database size={23} />
        </div>
        <h2 id={`${id}-ready-title`}>
          {blocked
            ? "Your warehouse comes first"
            : "Measures could not be loaded"}
        </h2>
        <p role={blocked ? undefined : "alert"}>
          {loadError ||
            "Configure a SQL Server connection and complete a successful load to start defining measures."}
        </p>
        <div className={styles.actions}>
          <Link href="/settings" className="button button-primary">
            Connection settings <ArrowRight size={13} />
          </Link>
          <Link
            href={`/projects/${projectId}/generate`}
            className="button button-outline"
          >
            Generate & run
          </Link>
          <Button
            variant="ghost"
            onClick={() => {
              setLoading(true);
              setLoadError("");
              setBlocked(false);
              void load();
            }}
          >
            Try again
          </Button>
        </div>
        <p className={styles.small}>
          Measures query your loaded star schema.{" "}
          <Link href={`/projects/${projectId}/runs`}>View run history</Link>
        </p>
      </section>
    );

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <span className={styles.meta}>
          <Sigma size={14} /> {model.measures.length} measures <span>·</span>{" "}
          {model.hierarchies.length} hierarchies
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfirmation({ kind: "regenerate" })}
          disabled={saving}
        >
          <RefreshCw size={12} /> Regenerate defaults
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          <AlertCircle size={14} /> {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          <Check size={14} /> {notice}
        </p>
      )}
      <div className={styles.editorGrid}>
        <aside
          className={styles.library}
          aria-labelledby={`${id}-library-title`}
        >
          <div className={styles.panelHeader}>
            <h2 id={`${id}-library-title`}>Measures</h2>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => selectMeasure(null)}
              disabled={saving}
              aria-label="Add measure"
            >
              <Plus size={14} /> Add
            </Button>
          </div>
          <div className={styles.measureList}>
            {grouped.map(([folder, measures]) => (
              <div key={folder} className={styles.folder}>
                <h3>
                  <Folder size={11} /> {folder}
                </h3>
                {measures.map((measure) => (
                  <button
                    type="button"
                    key={measure.id}
                    className={`${styles.measureItem} ${draft?.id === measure.id ? styles.selected : ""}`}
                    onClick={() => selectMeasure(measure.id)}
                    disabled={saving}
                    aria-pressed={draft?.id === measure.id}
                  >
                    <Sigma size={13} />
                    <span>{measure.name}</span>
                    <span className={styles.measureKind}>
                      {measure.isAuto ? "AUTO" : "CUSTOM"}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {!model.measures.length && (
              <p className={styles.emptyList}>
                No measures yet. Add one or regenerate the defaults.
              </p>
            )}
          </div>
          <div className={styles.libraryFoot}>
            <Info size={12} /> Custom measures survive regeneration.
          </div>
        </aside>
        <section
          className={styles.editor}
          aria-labelledby={`${id}-editor-title`}
        >
          <div className={styles.panelHeader}>
            <div className={styles.editorHeading}>
              <h2 id={`${id}-editor-title`}>
                {draft
                  ? savedDraft
                    ? "Edit measure"
                    : "New measure"
                  : "Measure editor"}
              </h2>
              <span className={styles.small}>
                {dirty ? "Unsaved changes" : "Saved"}
              </span>
            </div>
            {draft && (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => setConfirmation({ kind: "delete" })}
                aria-label={`Delete ${draft.name || "new measure"}`}
              >
                <Trash2 size={13} />
              </Button>
            )}
          </div>
          {draft ? (
            <div className={styles.editorBody}>
              <div className={styles.fields}>
                <label className={styles.field}>
                  Name
                  <input
                    value={draft.name}
                    maxLength={128}
                    disabled={saving}
                    onChange={(event) => edit("name", event.target.value)}
                    placeholder="Total Sales"
                  />
                </label>
                <label className={styles.field}>
                  Folder
                  <input
                    value={draft.folder}
                    maxLength={128}
                    disabled={saving}
                    onChange={(event) => edit("folder", event.target.value)}
                    placeholder="General"
                  />
                </label>
              </div>
              <label className={styles.field}>
                Description
                <input
                  value={draft.description}
                  maxLength={2000}
                  disabled={saving}
                  onChange={(event) => edit("description", event.target.value)}
                  placeholder="What should someone know about this measure?"
                />
              </label>
              <div className={styles.expressionHeader}>
                <label htmlFor={`${id}-expression`}>Expression</label>
                <span className={styles.small}>
                  {draft.expression.length.toLocaleString("en-US")} / 2,000
                </span>
              </div>
              <textarea
                ref={expressionInput}
                id={`${id}-expression`}
                className={styles.expression}
                value={draft.expression}
                maxLength={2000}
                rows={5}
                disabled={saving}
                onChange={(event) => edit("expression", event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="DIVIDE([Profit], [Sales])"
                aria-describedby={`${id}-expression-help ${id}-validation`}
                aria-invalid={Boolean(validation && !validation.ok)}
              />
              <p id={`${id}-expression-help`} className={styles.small}>
                Reference measures with [Name] and columns with Table[Column].
                This language uses its own syntax; it is not DAX.
              </p>
              <div
                id={`${id}-validation`}
                className={styles.validation}
                aria-live="polite"
              >
                {validating ? (
                  <span>
                    <Loader2 size={12} className="animate-spin" /> Checking
                    expression…
                  </span>
                ) : validationError ? (
                  <span className={styles.validationError}>
                    <AlertCircle size={12} /> {validationError}
                  </span>
                ) : validation?.ok ? (
                  <span className={styles.validationValid}>
                    <Check size={12} /> Valid expression
                  </span>
                ) : (
                  (validation?.errors.map((issue, index) => (
                    <button
                      key={`${index}-${issue.message}`}
                      type="button"
                      className={styles.validationError}
                      onClick={() => {
                        expressionInput.current?.focus();
                        if (issue.position !== undefined)
                          expressionInput.current?.setSelectionRange(
                            issue.position,
                            issue.position + 1,
                          );
                      }}
                    >
                      <AlertCircle size={12} />
                      <span>
                        {issue.message}
                        {issue.position !== undefined
                          ? ` (position ${issue.position + 1})`
                          : ""}
                      </span>
                    </button>
                  )) ?? <span>Enter an expression to validate it.</span>)
                )}
              </div>
              <div className={styles.formatRow}>
                <div className={styles.field}>
                  <label htmlFor={`${id}-format`}>Format</label>
                  <SelectMenu
                    id={`${id}-format`}
                    label="Measure format"
                    value={draft.format}
                    onValueChange={(value) => {
                      if (!saving) edit("format", value as MeasureFormat);
                    }}
                    options={[
                      { value: "number", label: "Number" },
                      { value: "currency", label: "Currency (USD)" },
                      { value: "percent", label: "Percent" },
                      { value: "decimals", label: "Two decimals" },
                    ]}
                  />
                </div>
                <span className={styles.small}>
                  Preview: {displayValue(0.1234, draft.format)}
                </span>
              </div>
              {validation?.ok && validation.sql && (
                <SqlPreview
                  title="Compiled SQL preview"
                  sql={validation.sql}
                  params={validation.params}
                />
              )}
              <div className={styles.editorActions}>
                <span className={styles.small}>
                  {draft.isAuto ? "Default measure" : "Custom measure"}
                </span>
                <div className={styles.actions}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runQuery(true)}
                    disabled={testing || dirty || !savedDraft || saving}
                    title={
                      dirty || !savedDraft
                        ? "Save this measure before testing its value."
                        : "Run this measure without grouping."
                    }
                  >
                    {testing ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Play size={12} />
                    )}{" "}
                    Test value
                  </Button>
                  <Button
                    size="sm"
                    onClick={save}
                    disabled={
                      !dirty ||
                      saving ||
                      !draft.name.trim() ||
                      !validation?.ok ||
                      validating
                    }
                  >
                    {saving ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}{" "}
                    {saving ? "Saving…" : "Save measure"}
                  </Button>
                </div>
              </div>
              {testError && (
                <p className={styles.error} role="alert">
                  {testError}
                </p>
              )}
              {testDiagnostics && (
                <SqlPreview
                  title="Generated SQL"
                  sql={
                    testDiagnostics.sql ??
                    "-- SQL is unavailable for this failed request."
                  }
                  timings={testDiagnostics.timings}
                  params={testDiagnostics.params}
                  timingLabel="Test value timing breakdown"
                  statisticsRequested={testStatisticsRequested}
                  onRunDiagnostics={() => void runQuery(true, true)}
                  diagnosticsDisabled={
                    testing || querying || dirty || !savedDraft || saving
                  }
                />
              )}
              {testResult && (
                <>
                  <div className={styles.testValue} role="status">
                    <span>{draft.name}</span>
                    <strong>
                      {displayValue(
                        testResult.rows[0]?.[testResult.columns[0]?.key] ??
                          null,
                        draft.format,
                      )}
                    </strong>
                    <span className={styles.small}>
                      {(
                        testResult.timings?.totalMs ?? testResult.elapsedMs
                      ).toFixed(0)}{" "}
                      ms · {testResult.fromCache ? "From cache" : "Live query"}
                    </span>
                  </div>
                  <SqlPreview
                    title="Generated SQL"
                    sql={testResult.sql}
                    timings={testResult.timings}
                    params={testResult.params}
                    timingLabel="Test value timing breakdown"
                    statisticsRequested={testStatisticsRequested}
                    onRunDiagnostics={() => void runQuery(true, true)}
                    diagnosticsDisabled={
                      testing || querying || dirty || !savedDraft || saving
                    }
                  />
                </>
              )}
            </div>
          ) : (
            <div className={styles.editorEmpty}>
              <Sigma size={25} />
              <p>Select a measure or add your own.</p>
              <Button variant="outline" onClick={() => selectMeasure(null)}>
                <Plus size={13} /> Add measure
              </Button>
            </div>
          )}
        </section>
      </div>
      <section
        className={styles.hierarchies}
        aria-labelledby={`${id}-hierarchies-title`}
      >
        <div className={styles.panelHeader}>
          <h2 id={`${id}-hierarchies-title`}>
            <GitBranch size={14} /> Hierarchies
          </h2>
          <span className={styles.small}>
            From your model&apos;s relationships
          </span>
        </div>
        <div className={styles.hierarchyList}>
          {model.hierarchies.length ? (
            model.hierarchies.map((hierarchy) => {
              const table = model.tables.find(
                (item) => item.id === hierarchy.tableId,
              );
              return (
                <div key={hierarchy.id} className={styles.hierarchy}>
                  <div>
                    <strong>{hierarchy.name}</strong>
                    <span className={styles.small}>
                      {table?.name ?? hierarchy.tableId}
                    </span>
                  </div>
                  <ol>
                    {hierarchy.levels.map((level, index) => (
                      <li key={`${index}-${level}`}>
                        {index > 0 && (
                          <ChevronRight size={12} aria-hidden="true" />
                        )}
                        <span>
                          {table?.columns.find((column) => column.id === level)
                            ?.name ?? level}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })
          ) : (
            <p className={styles.emptyList}>
              No supported hierarchies were found. Dimensions with functional
              dependencies receive a hierarchy automatically.
            </p>
          )}
        </div>
      </section>
      <section
        className={styles.queryTester}
        aria-labelledby={`${id}-query-title`}
      >
        <div className={styles.panelHeader}>
          <div>
            <h2 id={`${id}-query-title`}>Query tester</h2>
            <p className={styles.small}>
              Choose measures and up to two attributes. Results are limited to
              1,000 rows.
            </p>
          </div>
          <span className={styles.readonly}>
            <Database size={11} /> Read only
          </span>
        </div>
        <div className={styles.queryControls}>
          <fieldset className={styles.choices}>
            <legend>Measures</legend>
            <div className={styles.checkboxList}>
              {model.measures.map((measure) => (
                <label key={measure.id}>
                  <input
                    type="checkbox"
                    checked={selectedMeasures.includes(measure.id)}
                    disabled={querying}
                    onChange={(event) => {
                      setSelectedMeasures((current) =>
                        event.target.checked
                          ? [...current, measure.id]
                          : current.filter((item) => item !== measure.id),
                      );
                      setQueryResult(null);
                      setQueryError("");
                      setQueryDiagnostics(null);
                    }}
                  />
                  <span>{measure.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.choices}>
            <legend>
              Group by <span>(optional, up to two)</span>
            </legend>
            <div className={styles.checkboxList}>
              {attributes.map((attribute) => (
                <label key={attribute.id}>
                  <input
                    type="checkbox"
                    checked={selectedAttributes.includes(attribute.id)}
                    disabled={
                      querying ||
                      (selectedAttributes.length >= 2 &&
                        !selectedAttributes.includes(attribute.id))
                    }
                    onChange={(event) => {
                      setSelectedAttributes((current) =>
                        event.target.checked
                          ? [...current, attribute.id]
                          : current.filter((item) => item !== attribute.id),
                      );
                      setQueryResult(null);
                      setQueryError("");
                      setQueryDiagnostics(null);
                    }}
                  />
                  <span>{attribute.label}</span>
                </label>
              ))}
              {!attributes.length && (
                <p className={styles.small}>
                  No grouping attributes are available.
                </p>
              )}
            </div>
          </fieldset>
        </div>
        <div className={styles.queryActions}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={hideUnknown}
              disabled={querying}
              onChange={(event) => {
                setHideUnknown(event.target.checked);
                setQueryResult(null);
                setQueryError("");
                setQueryDiagnostics(null);
              }}
            />{" "}
            Hide Unknown members
          </label>
          <div className={styles.actions}>
            {querying && (
              <Button variant="ghost" size="sm" onClick={cancelQuery}>
                <X size={12} /> Cancel
              </Button>
            )}
            <Button
              size="sm"
              disabled={querying || !selectedMeasures.length}
              onClick={() => void runQuery(false)}
            >
              {querying ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}{" "}
              {querying ? "Running…" : "Run query"}
            </Button>
          </div>
        </div>
        {queryError && (
          <p className={styles.error} role="alert">
            {queryError}
          </p>
        )}
        {queryDiagnostics && (
          <div className={styles.queryOutput}>
            <SqlPreview
              title="Generated SQL"
              sql={
                queryDiagnostics.sql ??
                "-- SQL is unavailable for this failed request."
              }
              timings={queryDiagnostics.timings}
              params={queryDiagnostics.params}
              statisticsRequested={queryStatisticsRequested}
              onRunDiagnostics={() => void runQuery(false, true)}
              diagnosticsDisabled={
                querying ||
                testing ||
                dirty ||
                saving ||
                !selectedMeasures.length
              }
            />
          </div>
        )}
        {queryResult ? (
          <div className={styles.queryOutput}>
            <div className={styles.resultMeta} role="status">
              <span>
                {queryResult.rowCount.toLocaleString("en-US")} rows
                {queryResult.truncated ? " · Limit reached" : ""}
              </span>
              <span>
                <Clock3 size={11} />{" "}
                {(
                  queryResult.timings?.totalMs ?? queryResult.elapsedMs
                ).toFixed(0)}{" "}
                ms{" "}
                <span className={queryResult.fromCache ? styles.cacheHit : ""}>
                  {queryResult.fromCache ? "From cache" : "Live query"}
                </span>
              </span>
            </div>
            <div
              className={styles.tableScroll}
              tabIndex={0}
              aria-label="Query results"
            >
              <table>
                <thead>
                  <tr>
                    {queryResult.columns.map((column) => (
                      <th key={column.key} scope="col">
                        {column.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.slice(0, 1000).map((row, index) => (
                    <tr key={index}>
                      {queryResult.columns.map((column) => (
                        <td key={column.key}>
                          {displayValue(
                            row[column.key] ?? null,
                            column.role === "measure"
                              ? model.measures.find(
                                  (measure) => measure.name === column.name,
                                )?.format
                              : undefined,
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!queryResult.rows.length && (
                <p className={styles.emptyList}>No rows matched this query.</p>
              )}
            </div>
            <SqlPreview
              title="Generated SQL"
              sql={queryResult.sql}
              timings={queryResult.timings}
              params={queryResult.params}
              statisticsRequested={queryStatisticsRequested}
              onRunDiagnostics={() => void runQuery(false, true)}
              diagnosticsDisabled={
                querying ||
                testing ||
                dirty ||
                saving ||
                !selectedMeasures.length
              }
            />
          </div>
        ) : !queryError ? (
          <div className={styles.queryEmpty}>
            <Play size={16} />
            <span>Pick a measure, then run your first query.</span>
          </div>
        ) : null}
      </section>
      <dialog
        ref={confirmDialog}
        className={styles.dialog}
        onCancel={() => setConfirmation(null)}
        onClose={() => setConfirmation(null)}
        aria-labelledby={`${id}-confirm-title`}
        aria-describedby={`${id}-confirm-description`}
      >
        <h2 id={`${id}-confirm-title`}>
          {confirmation?.kind === "regenerate"
            ? "Regenerate default measures?"
            : confirmation?.kind === "delete"
              ? `Delete ${draft?.name || "this measure"}?`
              : "Discard unsaved changes?"}
        </h2>
        <p id={`${id}-confirm-description`}>
          {confirmation?.kind === "regenerate"
            ? "Automatic measures and hierarchies will be refreshed from the current model. Your custom measures will be preserved. Unsaved changes will be discarded."
            : confirmation?.kind === "delete"
              ? "Measures that reference this one may need updating. Deleted default measures return when you regenerate defaults."
              : "Your changes to this measure have not been saved."}
        </p>
        <div className={styles.actions}>
          <Button
            variant="outline"
            autoFocus
            onClick={() => setConfirmation(null)}
          >
            Keep editing
          </Button>
          <Button onClick={confirmAction}>
            {confirmation?.kind === "regenerate"
              ? "Regenerate defaults"
              : confirmation?.kind === "delete"
                ? "Delete measure"
                : "Discard changes"}
          </Button>
        </div>
      </dialog>
    </div>
  );
}

function SqlPreview({
  title,
  sql,
  params,
  timings,
  timingLabel = "Query timing breakdown",
  statisticsRequested = false,
  onRunDiagnostics,
  diagnosticsDisabled = false,
}: {
  title: string;
  sql: string;
  params?: ExpressionValidation["params"];
  timings?: QueryTimings;
  timingLabel?: string;
  statisticsRequested?: boolean;
  onRunDiagnostics?: () => void;
  diagnosticsDisabled?: boolean;
}) {
  return (
    <details className={styles.sql} open={statisticsRequested || undefined}>
      <summary>
        {title}
        <span>T-SQL</span>
      </summary>
      {onRunDiagnostics && (
        <div className={styles.diagnosticsAction}>
          <p>Compare SQL Server planning and execution with the app timings.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={onRunDiagnostics}
            disabled={diagnosticsDisabled}
            title="Run the current selection without the result cache and collect SQL Server timings."
          >
            <Clock3 size={12} /> Run diagnostics
          </Button>
        </div>
      )}
      <pre tabIndex={0} aria-label={title}>
        <code>{sql}</code>
      </pre>
      {Boolean(params?.length) && (
        <div className={styles.params}>
          <strong>Parameter values</strong>
          <pre tabIndex={0} aria-label="Parameter values">
            <code>{JSON.stringify(params, null, 2)}</code>
          </pre>
        </div>
      )}
      {timings && (
        <TimingBreakdown
          timings={timings}
          label={timingLabel}
          statisticsRequested={statisticsRequested}
        />
      )}
    </details>
  );
}

const timingPhases: readonly [keyof QueryTimings, string][] = [
  ["parseMs", "Parse"],
  ["compileMs", "Node compile"],
  ["cacheLookupMs", "Cache lookup"],
  ["queueMs", "Database queue"],
  ["poolAcquireMs", "Pool acquire"],
  ["connectMs", "Connect / login"],
  ["sendToFirstRowMs", "Send to first row"],
  ["fetchMs", "Fetch rows"],
  ["totalMs", "Total"],
];

function TimingBreakdown({
  timings,
  label,
  statisticsRequested,
}: {
  timings: QueryTimings;
  label: string;
  statisticsRequested: boolean;
}) {
  const sqlPhases: [keyof QueryTimings, string, keyof QueryTimings][] = [
    ["sqlCompileMs", "SQL compile", "sqlCompileCpuMs"],
    ["sqlExecuteMs", "SQL execute", "sqlExecuteCpuMs"],
  ];
  const showSqlStatistics =
    statisticsRequested ||
    sqlPhases.some(([key]) => timings[key] !== undefined);
  return (
    <section className={styles.timing} aria-label={label}>
      <div className={styles.timingHeader}>
        <h3>Timing</h3>
        <span>Phases over 2 seconds are flagged.</span>
      </div>
      <dl className={styles.timingGrid}>
        {[
          ...timingPhases.map(
            ([key, label]) => [key, label, undefined] as const,
          ),
          ...(showSqlStatistics ? sqlPhases : []),
        ].map(([key, label, cpuKey]) => {
          const milliseconds = timings[key];
          const available =
            typeof milliseconds === "number" &&
            Number.isFinite(milliseconds) &&
            milliseconds >= 0;
          const slow = available && milliseconds > 2_000;
          const cpu = cpuKey ? timings[cpuKey] : undefined;
          return (
            <div key={key} className={slow ? styles.timingSlow : undefined}>
              <dt>{label}</dt>
              <dd>
                <span>
                  {available
                    ? `${milliseconds.toLocaleString("en-US", {
                        maximumFractionDigits: 2,
                      })} ms`
                    : "Unavailable"}
                </span>
                {typeof cpu === "number" &&
                  Number.isFinite(cpu) &&
                  cpu >= 0 && (
                    <small className={styles.sqlCpu}>
                      CPU{" "}
                      {cpu.toLocaleString("en-US", {
                        maximumFractionDigits: 2,
                      })}{" "}
                      ms
                    </small>
                  )}
                {slow && (
                  <span className={styles.timingFlag}>
                    <AlertCircle size={11} aria-hidden="true" /> Slow phase
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {showSqlStatistics && (
        <p className={styles.sqlStatisticsNote}>
          SQL timings are reported by SQL Server.{" "}
          {sqlPhases.some(([key]) => timings[key] === undefined)
            ? "Some statistics were not reported for this request."
            : "CPU time is shown separately from elapsed time."}
        </p>
      )}
    </section>
  );
}
