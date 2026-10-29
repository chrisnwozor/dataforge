import { parseExpression } from "@/lib/semantic/expr/parser";
import type { Expr } from "@/lib/semantic/expr/types";
import type { SemanticModel } from "@/lib/semantic/types";
import type {
  AttributeRef,
  QueryFilter,
  QueryResult,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import type { ViewConfig } from "@/lib/explore/config";
import type {
  DashboardTile,
  KpiTile,
  SavedDashboard,
} from "@/lib/dashboards/schema";
import {
  DashboardQueryController,
  DashboardTileCache,
} from "@/lib/dashboards/query-controller";
import { buildReferenceQuery, UnsupportedReferenceError } from "./reference";
import {
  artifactOutcome,
  compareArtifactResults,
  numberComparison,
  safeArtifactCase,
  skipArtifact,
} from "./reports";
import type { CheckCase, EngineExecutor, ReferenceExecutor } from "./types";

export interface DashboardTileObservation {
  result?: QueryResult;
  comparison?: { result: QueryResult; label: string; measure: string };
  periodLabel?: string;
  error?: string;
}
export type DashboardObservation = Record<string, DashboardTileObservation>;
export interface DashboardChecksInput {
  model: SemanticModel;
  dashboards: readonly SavedDashboard[];
  views?: readonly { id: string; config: ViewConfig }[];
  engine: EngineExecutor;
  reference: ReferenceExecutor;
  observeDashboard?: (
    dashboard: SavedDashboard,
    signal: AbortSignal,
  ) => Promise<DashboardObservation>;
  asOfDate?: string;
  absoluteTolerance?: number;
  relativeTolerance?: number;
}
export interface DashboardObservationOptions {
  asOfDate?: string;
  lastSuccessfulRunId?: string | null;
  timeoutMs?: number;
}
/** Actual dashboard controller, with a fresh cache and one pending tile, not a new tile engine. */
export async function collectDashboardObservation(
  dashboard: SavedDashboard,
  model: SemanticModel,
  views: DashboardChecksInput["views"],
  engine: EngineExecutor,
  signal: AbortSignal,
  options: DashboardObservationOptions = {},
): Promise<DashboardObservation> {
  signal.throwIfAborted();
  const tiles = dashboard.layout.tiles.filter(
    (tile) => tile.type === "chart" || tile.type === "kpi",
  );
  if (!tiles.length) return {};
  const controller = new DashboardQueryController(
    dashboard.projectId,
    async (_url, init) => {
      const query = JSON.parse(String(init.body)) as SemanticQuery;
      const combined = init.signal
        ? AbortSignal.any([signal, init.signal])
        : signal;
      const result = await engine({ ...query, cache: "bypass" }, combined);
      return Response.json(result);
    },
    new DashboardTileCache({ maxEntries: 1, maxBytes: 1024 }),
    1,
  );
  return new Promise<DashboardObservation>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      unsubscribe();
      const state = controller.getSnapshot();
      controller.dispose();
      if (error) {
        reject(error);
        return;
      }
      resolve(
        Object.fromEntries(
          tiles.map((tile) => {
            const row = state[tile.id];
            return [
              tile.id,
              {
                result: row?.result,
                comparison: row?.kpi?.comparison,
                periodLabel: row?.kpi?.periodLabel,
                error: row?.status === "error" ? row.error : row?.totalsError,
              },
            ];
          }),
        ),
      );
    };
    const abort = () =>
      finish(
        signal.reason ??
          new DOMException("Dashboard checks cancelled.", "AbortError"),
      );
    const ready = () => {
      const state = controller.getSnapshot();
      if (
        tiles.every((tile) =>
          ["success", "error"].includes(state[tile.id]?.status ?? ""),
        )
      )
        finish();
    };
    const unsubscribe = controller.subscribe(ready);
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            "Dashboard observation exceeded its two-minute verification limit.",
          ),
        ),
      options.timeoutMs ?? 120_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    controller.configure({
      projectId: dashboard.projectId,
      model,
      lastSuccessfulRunId: options.lastSuccessfulRunId ?? null,
      tiles: dashboard.layout.tiles,
      views: views ?? [],
      filters: dashboard.filters.items,
      visibleIds: tiles.map((tile) => tile.id),
      refreshToken: 1,
      ...(options.asOfDate ? { asOfDate: options.asOfDate } : {}),
    });
    if (signal.aborted) abort();
    else ready();
  });
}
const baseQuery = (): SemanticQuery => ({
  measures: [],
  rows: [],
  columns: [],
  filters: [],
  orderBy: [],
  limit: 10_000,
  hideUnknown: true,
  cache: "bypass",
});
function resolveTable(model: SemanticModel, ref: string) {
  return model.tables.find(
    (table) =>
      table.id === ref ||
      table.name.toLowerCase() === ref.toLowerCase() ||
      table.sqlName.toLowerCase() === ref.toLowerCase(),
  );
}
function canonicalAttribute(
  model: SemanticModel,
  ref: AttributeRef,
): AttributeRef | null {
  const table = resolveTable(model, ref.table),
    column = table?.columns.find(
      (c) =>
        c.id === ref.column ||
        c.name.toLowerCase() === ref.column.toLowerCase() ||
        c.sqlName.toLowerCase() === ref.column.toLowerCase(),
    );
  return table && column && column.role === "attribute"
    ? { table: table.id, column: column.id }
    : null;
}

function tileFilters(
  input: DashboardChecksInput,
  dashboard: SavedDashboard,
  base: readonly QueryFilter[],
): QueryFilter[] {
  const reachable = new Set([input.model.factTableId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relationship of input.model.relationships)
      if (
        reachable.has(relationship.fromTableId) &&
        !reachable.has(relationship.toTableId)
      ) {
        reachable.add(relationship.toTableId);
        changed = true;
      }
  }
  const filters = [
    ...base,
    ...dashboard.filters.items.flatMap((filter) => {
      const attribute = canonicalAttribute(input.model, filter.attribute);
      return attribute && reachable.has(attribute.table)
        ? [{ ...filter, attribute }]
        : [];
    }),
  ];
  return [
    ...new Map(
      filters.map((filter) => [JSON.stringify(filter), filter]),
    ).values(),
  ];
}
function dateAttribute(model: SemanticModel): AttributeRef | null {
  if (!model.date) return null;
  const table = model.tables.find((t) => t.id === model.date!.tableId),
    column = table?.columns.find((c) => c.id === model.date!.dateColumnId);
  return table && column && column.type === "date"
    ? { table: table.id, column: column.id }
    : null;
}
function sourceView(
  tile: DashboardTile,
  views: DashboardChecksInput["views"],
): ViewConfig | null {
  if (tile.type !== "chart") return null;
  return tile.source.kind === "inline"
    ? tile.source.config
    : (views?.find(
        (view) =>
          view.id === (tile.source.kind === "view" ? tile.source.viewId : ""),
      )?.config ?? null);
}
export interface IndependentPeriod {
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
  label: string;
  previousLabel: string;
}
const calendarDate = (year: number, month: number, day: number) => {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  return date;
};
const iso = (date: Date) => date.toISOString().slice(0, 10);
/** Separate calendar arithmetic; never imports the production KPI-period helper. */
export function independentLatestPeriod(
  latestDate: string,
  unit: "year" | "quarter" | "month",
  asOfDate: string,
): IndependentPeriod | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(latestDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) ||
    !Number.isFinite(Date.parse(latestDate)) ||
    !Number.isFinite(Date.parse(asOfDate)) ||
    new Date(latestDate).toISOString().slice(0, 10) !== latestDate ||
    new Date(asOfDate).toISOString().slice(0, 10) !== asOfDate
  )
    return null;
  const anchor = new Date(
      `${latestDate < asOfDate ? latestDate : asOfDate}T00:00:00Z`,
    ),
    width = unit === "year" ? 12 : unit === "quarter" ? 3 : 1;
  let first = calendarDate(
    anchor.getUTCFullYear(),
    Math.floor(anchor.getUTCMonth() / width) * width,
    1,
  );
  let last = calendarDate(
    first.getUTCFullYear(),
    first.getUTCMonth() + width,
    0,
  );
  if (iso(last) > asOfDate) {
    first = calendarDate(
      first.getUTCFullYear(),
      first.getUTCMonth() - width,
      1,
    );
    last = calendarDate(first.getUTCFullYear(), first.getUTCMonth() + width, 0);
  }
  if (first.getUTCFullYear() < 2) return null;
  const previous = calendarDate(
      first.getUTCFullYear(),
      first.getUTCMonth() - width,
      1,
    ),
    previousLast = calendarDate(first.getUTCFullYear(), first.getUTCMonth(), 0);
  const label = (d: Date) =>
    unit === "year"
      ? String(d.getUTCFullYear())
      : unit === "quarter"
        ? `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
        : `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return {
    start: iso(first),
    end: iso(last),
    previousStart: iso(previous),
    previousEnd: iso(previousLast),
    label: label(first),
    previousLabel: label(previous),
  };
}
function comparisonUnit(
  model: SemanticModel,
  ref: string,
): "year" | "quarter" | "month" | null {
  const units = new Set<"year" | "quarter" | "month">(),
    visited = new Set<string>();
  const measure = (name: string) => {
    const value = model.measures.find(
      (m) => m.id === name || m.name.toLowerCase() === name.toLowerCase(),
    );
    if (!value || visited.has(value.id)) return;
    visited.add(value.id);
    walk(parseExpression(value.expression));
  };
  const walk = (node: Expr): void => {
    if (node.kind === "measure") measure(node.name);
    else if (node.kind === "call") {
      if (node.name.toUpperCase() === "SAMEPERIODLASTYEAR") units.add("year");
      if (
        node.name.toUpperCase() === "PREVIOUSPERIOD" &&
        node.args[1]?.kind === "period"
      )
        units.add(
          node.args[1].value.toLowerCase() as "year" | "quarter" | "month",
        );
      node.args.forEach(walk);
    } else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    } else if (node.kind === "unary") walk(node.operand);
    else if (node.kind === "in") {
      walk(node.expression);
      node.values.forEach(walk);
    }
  };
  measure(ref);
  return units.size === 1 ? [...units][0] : null;
}
function standardComparisonBase(
  model: SemanticModel,
  ref: string,
): string | null {
  const find = (name: string) =>
    model.measures.find(
      (m) => m.id === name || m.name.toLowerCase() === name.toLowerCase(),
    );
  const expand = (node: Expr, depth = 0): Expr => {
    if (depth > 64)
      throw new UnsupportedReferenceError(
        "Comparison expression exceeds the independent expansion limit.",
      );
    if (node.kind !== "measure") return node;
    const measure = find(node.name);
    if (!measure)
      throw new UnsupportedReferenceError(
        "The KPI comparison references a missing measure.",
      );
    return expand(parseExpression(measure.expression), depth + 1);
  };
  const initial = find(ref);
  if (!initial) return null;
  const root = expand(parseExpression(initial.expression));
  if (root.kind === "call" && root.name === "DIVIDE" && root.args.length > 2)
    throw new UnsupportedReferenceError(
      "This KPI comparison has an alternate DIVIDE result. The independent period interpreter does not yet evaluate alternate expressions; its separate semantic check still applies.",
    );
  const numerator =
    root.kind === "call" && root.name === "DIVIDE"
      ? root.args[0]
      : root.kind === "binary" && root.op === "/"
        ? root.left
        : null;
  const denominator =
    root.kind === "call" && root.name === "DIVIDE"
      ? root.args[1]
      : root.kind === "binary" && root.op === "/"
        ? root.right
        : null;
  if (!numerator || !denominator) return null;
  const difference = expand(numerator);
  if (
    difference.kind !== "binary" ||
    difference.op !== "-" ||
    difference.left.kind !== "measure"
  )
    return null;
  const current = find(difference.left.name),
    prior = expand(denominator),
    subtracted = expand(difference.right);
  if (
    !current ||
    prior.kind !== "call" ||
    !["SAMEPERIODLASTYEAR", "PREVIOUSPERIOD"].includes(prior.name) ||
    prior.args[0]?.kind !== "measure" ||
    find(prior.args[0].name)?.id !== current.id
  )
    return null;
  const withoutPosition = (node: Expr): unknown =>
    node.kind === "call"
      ? {
          kind: node.kind,
          name: node.name,
          args: node.args.map(withoutPosition),
        }
      : node.kind === "measure"
        ? { kind: node.kind, id: find(node.name)?.id ?? node.name }
        : node.kind === "period"
          ? { kind: node.kind, value: node.value }
          : node.kind === "literal"
            ? { kind: node.kind, value: node.value }
            : { kind: node.kind };
  return JSON.stringify(withoutPosition(prior)) ===
    JSON.stringify(withoutPosition(subtracted))
    ? current.id
    : null;
}

function periodFilters(
  attribute: AttributeRef,
  start: string,
  end: string,
): QueryFilter[] {
  return [
    { attribute, op: "gte", value: start },
    { attribute, op: "lte", value: end },
  ];
}
async function latestFactDate(
  input: DashboardChecksInput,
  filters: QueryFilter[],
  signal: AbortSignal,
): Promise<{ date: string | null; sql: string }> {
  const attribute = dateAttribute(input.model);
  if (!attribute) return { date: null, sql: "" };
  const measure = input.model.measures.find((m) =>
    /^\s*(SUM|COUNT|COUNT_BIG|MIN|MAX|AVG)\s*\(/i.test(m.expression),
  );
  if (!measure)
    throw new UnsupportedReferenceError(
      "No simple base measure is available to establish the latest observed fact date independently.",
    );
  const query = buildReferenceQuery(input.model, {
    ...baseQuery(),
    measures: [measure.id],
    rows: [attribute],
    filters: [...filters, { attribute, op: "isNotNull" }],
    orderBy: [{ ref: attribute, dir: "desc" }],
    limit: 1,
  });
  const rows = await input.reference(query, signal),
    column = query.columns.find((c) => c.role === "attribute"),
    value = column ? rows[0]?.[column.key] : null;
  return {
    date: typeof value === "string" ? value.slice(0, 10) : null,
    sql: query.sql,
  };
}
async function standaloneQuery(
  input: DashboardChecksInput,
  dashboard: SavedDashboard,
  tile: DashboardTile,
  signal: AbortSignal,
): Promise<SemanticQuery> {
  if (tile.type === "chart") {
    const view = sourceView(tile, input.views);
    if (!view) throw new Error("The tile's saved Explore view is missing.");
    return {
      ...baseQuery(),
      measures: view.values,
      rows: view.viz === "kpi" ? [] : view.rows,
      columns: view.viz === "kpi" ? [] : view.columns,
      filters: tileFilters(input, dashboard, view.filters),
      orderBy: view.viz === "kpi" ? [] : view.sort,
      ...(view.viz !== "kpi" && view.topN ? { topN: view.topN } : {}),
    };
  }
  if (tile.type !== "kpi")
    throw new UnsupportedReferenceError(
      "Text and slicer tiles do not produce a numeric query result.",
    );
  let filters = tileFilters(input, dashboard, []);
  const date = dateAttribute(input.model),
    unit =
      tile.period === "latestYear"
        ? "year"
        : tile.period === "latestQuarter"
          ? "quarter"
          : tile.period === "latestMonth"
            ? "month"
            : null;
  if (date && unit) {
    const nonDate = filters.filter(
        (f) =>
          canonicalAttribute(input.model, f.attribute)?.table !== date.table,
      ),
      latest = await latestFactDate(input, nonDate, signal),
      period = latest.date
        ? independentLatestPeriod(
            latest.date,
            unit,
            input.asOfDate ?? iso(new Date()),
          )
        : null;
    filters = [
      ...nonDate,
      ...(period
        ? periodFilters(date, period.start, period.end)
        : [{ attribute: date, op: "in" as const, values: [] }]),
    ];
  }
  return { ...baseQuery(), measures: [tile.measure], filters, limit: 1 };
}
function resultMeasure(
  result: QueryResult,
  ordinal = 0,
): QueryValue | undefined {
  const column = result.columns.filter((c) => c.role === "measure")[ordinal];
  return column ? result.rows[0]?.[column.key] : undefined;
}
async function kpiComparisonCheck(
  input: DashboardChecksInput,
  dashboard: SavedDashboard,
  tile: KpiTile,
  observed: DashboardTileObservation,
  signal: AbortSignal,
) {
  const date = dateAttribute(input.model);
  if (!date)
    return skipArtifact(
      "This model has no date dimension, so the KPI period comparison must stay hidden.",
      "Add and load a date dimension before checking period comparisons.",
    );
  if (!tile.comparisonMeasure)
    return skipArtifact(
      "This KPI has no selected comparison measure.",
      "Choose a year/quarter/month-over-period comparison measure in the tile settings.",
    );
  const unit = comparisonUnit(input.model, tile.comparisonMeasure);
  if (!unit)
    return skipArtifact(
      "The selected comparison has no single prior-period type that can be reconciled independently.",
      "Use an unambiguous YoY, QoQ or MoM comparison, or inspect its separate semantic measure check.",
    );
  const comparisonBase = standardComparisonBase(
    input.model,
    tile.comparisonMeasure,
  );
  if (!comparisonBase)
    return skipArtifact(
      "This comparison is not a recognizable (current - prior) / prior expression. Its semantic-measure reference check remains available.",
      "Use a standard period-change measure or extend the independent KPI comparison interpreter; no value was assumed.",
    );
  const filters = tileFilters(input, dashboard, []).filter(
      (f) => canonicalAttribute(input.model, f.attribute)?.table !== date.table,
    ),
    latest = await latestFactDate(input, filters, signal);
  const period = latest.date
    ? independentLatestPeriod(
        latest.date,
        unit,
        input.asOfDate ?? iso(new Date()),
      )
    : null;
  if (!period)
    return skipArtifact(
      "No fully closed comparison period is available in the observed fact dates.",
    );
  if (observed.error) throw new Error(observed.error);
  if (!observed.comparison)
    throw new Error("The dashboard omitted its configured period comparison.");
  const current = buildReferenceQuery(input.model, {
      ...baseQuery(),
      measures: [comparisonBase],
      filters: [...filters, ...periodFilters(date, period.start, period.end)],
      limit: 1,
    }),
    previous = buildReferenceQuery(input.model, {
      ...baseQuery(),
      measures: [comparisonBase],
      filters: [
        ...filters,
        ...periodFilters(date, period.previousStart, period.previousEnd),
      ],
      limit: 1,
    });
  const currentRows = await input.reference(current, signal),
    previousRows = await input.reference(previous, signal),
    currentColumn = current.columns.find((c) => c.role === "measure"),
    previousColumn = previous.columns.find((c) => c.role === "measure");
  const a = currentColumn ? currentRows[0]?.[currentColumn.key] : null,
    b = previousColumn ? previousRows[0]?.[previousColumn.key] : null;
  const expected =
      a === null ||
      a === undefined ||
      b === null ||
      b === undefined ||
      Number(b) === 0
        ? null
        : (Number(a) - Number(b)) / Number(b),
    label = `${period.label} vs ${period.previousLabel}`;
  const comparison = numberComparison(
    `${tile.title || tile.measure}: independent ${unit} change`,
    expected,
    resultMeasure(observed.comparison.result),
    input.absoluteTolerance,
    input.relativeTolerance,
  );
  return artifactOutcome(
    [
      comparison,
      {
        label: "Comparison period label",
        expected: label,
        actual: observed.comparison.label,
        difference: null,
        tolerance: 0,
        pass: label === observed.comparison.label,
      },
    ],
    `The latest closed ${unit} was selected from actual fact dates using separate UTC calendar arithmetic. The change was recomputed as (current - previous) / previous from two independent base-measure queries; the entire date range was not shifted.`,
    observed.comparison.result.sql,
    [latest.sql, current.sql, previous.sql].join("\n\n"),
  );
}
export function createDashboardChecks(
  input: DashboardChecksInput,
): CheckCase[] {
  if (!input.dashboards.length)
    return [
      safeArtifactCase(
        "dashboards:none",
        "Dashboards",
        "Saved dashboard correctness",
        async () =>
          skipArtifact(
            "There are no saved dashboards to verify.",
            "Save a chart or KPI dashboard, then run checks again.",
          ),
      ),
    ];
  const checks: CheckCase[] = [];
  for (const dashboard of input.dashboards) {
    let observation: Promise<DashboardObservation> | undefined;
    const observe = (signal: AbortSignal) =>
      (observation ??= input.observeDashboard
        ? input.observeDashboard(dashboard, signal)
        : collectDashboardObservation(
            dashboard,
            input.model,
            input.views,
            input.engine,
            signal,
            { asOfDate: input.asOfDate },
          ));
    const tiles = dashboard.layout.tiles.filter(
      (tile) => tile.type === "chart" || tile.type === "kpi",
    );
    if (!tiles.length)
      checks.push(
        safeArtifactCase(
          `dashboard:${dashboard.id}:none`,
          "Dashboards",
          `${dashboard.name}: numeric tiles`,
          async () =>
            skipArtifact(
              "This dashboard contains only text/slicer tiles; there is no numeric tile result to reconcile.",
            ),
        ),
      );
    for (const tile of tiles) {
      checks.push(
        safeArtifactCase(
          `dashboard:${dashboard.id}:${tile.id}:individual`,
          "Dashboards",
          `${dashboard.name}: ${tile.title || tile.type} batch vs individual`,
          async (signal) => {
            const batch = (await observe(signal))[tile.id];
            if (!batch)
              throw new Error(
                "The dashboard controller did not return this tile.",
              );
            if (batch.error) throw new Error(batch.error);
            if (!batch.result)
              throw new Error("The dashboard returned no numeric tile result.");
            const query = await standaloneQuery(input, dashboard, tile, signal),
              individual = await input.engine(query, signal);
            return artifactOutcome(
              compareArtifactResults(
                individual,
                batch.result,
                `${dashboard.name} / ${tile.title || tile.id}`,
                input.absoluteTolerance,
                input.relativeTolerance,
              ),
              "The actual dashboard controller loaded every data tile through its queue with a fresh cache. This tile was then queried separately from independently reconstructed fields and filters; query aliases and row order were ignored, not values.",
              batch.result.sql,
              individual.sql,
            );
          },
        ),
      );
      if (tile.type === "kpi" && tile.comparisonMeasure)
        checks.push(
          safeArtifactCase(
            `dashboard:${dashboard.id}:${tile.id}:period`,
            "Dashboards",
            `${dashboard.name}: ${tile.title || tile.measure} latest-period comparison`,
            async (signal) =>
              kpiComparisonCheck(
                input,
                dashboard,
                tile,
                (await observe(signal))[tile.id] ?? {},
                signal,
              ),
          ),
        );
    }
  }
  return checks;
}
