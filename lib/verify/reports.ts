import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";
import type { ViewConfig } from "@/lib/explore/config";
import type {
  ReportExecutionData,
  PaginatedReport,
} from "@/lib/reports/pagination";
import type {
  ReportItem,
  ReportParameterValues,
  SavedReport,
} from "@/lib/reports/schema";
import type { SemanticModel } from "@/lib/semantic/types";
import type {
  AttributeRef,
  QueryFilter,
  QueryResult,
  QueryValue,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import {
  buildReferenceQuery,
  isAdditiveMeasure,
  UnsupportedReferenceError,
} from "./reference";
import type {
  CheckCase,
  CheckOutcome,
  CheckValue,
  ReferenceExecutor,
} from "./types";

export interface ReportObservation {
  data: ReportExecutionData;
  preview: PaginatedReport;
  csv?: Uint8Array;
  xlsx?: Uint8Array;
}
export interface ReportChecksInput {
  model: SemanticModel;
  reports: readonly SavedReport[];
  views?: readonly { id: string; config: ViewConfig }[];
  reference: ReferenceExecutor;
  observeReport?: (
    report: SavedReport,
    parameters: ReportParameterValues,
    signal: AbortSignal,
  ) => Promise<ReportObservation>;
  absoluteTolerance?: number;
  relativeTolerance?: number;
}
export interface ArtifactComparison {
  label: string;
  expected: CheckValue;
  actual: CheckValue;
  difference: number | null;
  tolerance: number;
  pass: boolean;
}
const MAX_ROWS = 10_000;
const MAX_CELLS = 100_000;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const refKey = (ref: AttributeRef) => JSON.stringify([ref.table, ref.column]);
const uniqueRefs = (refs: readonly AttributeRef[]) => [
  ...new Map(refs.map((ref) => [refKey(ref), ref])).values(),
];
const uniqueStrings = (values: readonly string[]) => [...new Set(values)];
const queryBase = (): SemanticQuery => ({
  measures: [],
  rows: [],
  columns: [],
  filters: [],
  orderBy: [],
  limit: MAX_ROWS,
  hideUnknown: true,
  cache: "bypass",
  report: true,
});
export function skipArtifact(
  explanation: string,
  nextStep = "Complete the prerequisites and run this check again.",
): CheckOutcome {
  return {
    status: "skipped",
    expected: null,
    actual: null,
    difference: null,
    tolerance: 0,
    explanation,
    nextStep,
    sql: "",
  };
}
export function numberComparison(
  label: string,
  expected: QueryValue | undefined,
  actual: QueryValue | undefined,
  absolute = 0.01,
  relative = 0.000001,
): ArtifactComparison {
  const expectedNull = expected === null || expected === undefined;
  const actualNull = actual === null || actual === undefined;
  if (expectedNull || actualNull)
    return {
      label,
      expected: expected ?? null,
      actual: actual ?? null,
      difference: expectedNull && actualNull ? 0 : null,
      tolerance: absolute,
      pass: expectedNull && actualNull,
    };
  const a =
    typeof actual === "number"
      ? actual
      : typeof actual === "string" && actual.trim()
        ? Number(actual)
        : NaN;
  const e =
    typeof expected === "number"
      ? expected
      : typeof expected === "string" && expected.trim()
        ? Number(expected)
        : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(e))
    return {
      label,
      expected,
      actual,
      difference: null,
      tolerance: absolute,
      pass: Object.is(expected, actual),
    };
  const tolerance = Math.max(absolute, Math.abs(e) * relative);
  return {
    label,
    expected: e,
    actual: a,
    difference: a - e,
    tolerance,
    pass: Math.abs(a - e) <= tolerance,
  };
}
export function artifactOutcome(
  comparisons: readonly ArtifactComparison[],
  explanation: string,
  sql = "",
  referenceSql = "",
): CheckOutcome {
  if (!comparisons.length)
    return {
      ...skipArtifact(
        "No comparable numeric values were produced. " + explanation,
      ),
      sql,
      referenceSql,
    };
  const failed = comparisons.filter((item) => !item.pass);
  const describe = (
    items: readonly ArtifactComparison[],
    field: "expected" | "actual",
  ): CheckValue => ({
    compared: comparisons.length,
    mismatches: failed.length,
    values: items
      .slice(0, 30)
      .map((item) => ({ context: item.label, value: item[field] })),
  });
  return {
    status: failed.length ? "fail" : "pass",
    expected: describe(failed.length ? failed : comparisons, "expected"),
    actual: describe(failed.length ? failed : comparisons, "actual"),
    difference: comparisons.reduce<number | null>(
      (worst, item) =>
        item.difference === null
          ? worst
          : worst === null || Math.abs(item.difference) > Math.abs(worst)
            ? item.difference
            : worst,
      null,
    ),
    tolerance: comparisons.reduce(
      (max, item) => Math.max(max, item.tolerance),
      0,
    ),
    explanation: `${failed.length ? `${failed.length} of ${comparisons.length} comparisons differ. ` : `${comparisons.length} comparisons agree. `}${explanation}`,
    nextStep: failed.length
      ? "Open the mismatched contexts and SQL below. Compare the saved report or tile fields and filters with the independent reference; retain the failing result while investigating."
      : "No action is needed. Re-run after the model or source data changes.",
    sql,
    referenceSql,
  };
}
export function safeArtifactCase(
  id: string,
  area: "Reports" | "Dashboards",
  name: string,
  run: CheckCase["run"],
): CheckCase {
  return {
    id,
    area,
    name,
    async run(signal) {
      signal.throwIfAborted();
      try {
        return await run(signal);
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        if (error instanceof UnsupportedReferenceError)
          return skipArtifact(
            error.message,
            "Choose a supported reference shape or extend the independent verifier; no production output was changed.",
          );
        return {
          status: "fail",
          expected: "A complete, comparable result",
          actual: null,
          difference: null,
          tolerance: 0,
          explanation:
            error instanceof Error
              ? error.message
              : "The artifact could not be checked.",
          nextStep:
            "Check the saved artifact, database connection and permissions, then retry. A query or export error is a failure, not a successful reconciliation.",
          sql: "",
        };
      }
    },
  };
}
function measureName(model: SemanticModel, ref: string): string {
  return (
    model.measures.find(
      (item) =>
        item.id === ref || item.name.toLowerCase() === ref.toLowerCase(),
    )?.name ?? ref
  );
}
function pickedResult(
  result: QueryResult,
  wanted: readonly string[],
  model: SemanticModel,
): QueryResult {
  const attributes = result.columns.filter((item) => item.role === "attribute");
  const metrics = wanted.map((ref) =>
    result.columns.find(
      (column) =>
        column.role === "measure" &&
        column.name.toLowerCase() === measureName(model, ref).toLowerCase(),
    ),
  );
  if (metrics.some((item) => !item))
    throw new Error(
      "The report result omitted a requested measure or changed its identity.",
    );
  return {
    ...result,
    columns: [...attributes, ...metrics.filter((item) => item !== undefined)],
  };
}
/** Compare members by tuple and measures by role order; SQL aliases need not match. */
export function compareArtifactResults(
  expected: QueryResult,
  actual: QueryResult,
  label: string,
  absolute = 0.01,
  relative = 0.000001,
): ArtifactComparison[] {
  if (
    expected.truncated ||
    actual.truncated ||
    expected.rows.length > MAX_ROWS ||
    actual.rows.length > MAX_ROWS
  )
    throw new UnsupportedReferenceError(
      "This artifact reached the verification row bound or returned truncated data; a partial result cannot prove correctness.",
    );
  const ea = expected.columns.filter((c) => c.role === "attribute"),
    aa = actual.columns.filter((c) => c.role === "attribute");
  const em = expected.columns.filter((c) => c.role === "measure"),
    am = actual.columns.filter((c) => c.role === "measure");
  if (ea.length !== aa.length || em.length !== am.length)
    return [
      {
        label: `${label}: shape`,
        expected: `${ea.length} attributes / ${em.length} measures`,
        actual: `${aa.length} attributes / ${am.length} measures`,
        difference: null,
        tolerance: 0,
        pass: false,
      },
    ];
  const normalize = (
    value: QueryValue | undefined,
    type: string,
  ): QueryValue =>
    value === undefined
      ? null
      : type === "date" && typeof value === "string"
        ? value.slice(0, 10)
        : value;
  const tuple = (
    row: QueryResult["rows"][number],
    attributes: QueryResult["columns"],
  ) =>
    JSON.stringify(
      attributes.map((column) => normalize(row[column.key], column.type)),
    );
  const expectedMembers = new Map(
    expected.rows.map((row) => [tuple(row, ea), row]),
  );
  const actualMembers = new Map(
    actual.rows.map((row) => [tuple(row, aa), row]),
  );
  const comparisons: ArtifactComparison[] = [
    {
      label: `${label}: member count`,
      expected: expected.rows.length,
      actual: actual.rows.length,
      difference: actual.rows.length - expected.rows.length,
      tolerance: 0,
      pass:
        expected.rows.length === actual.rows.length &&
        expectedMembers.size === expected.rows.length &&
        actualMembers.size === actual.rows.length,
    },
  ];
  for (const [member, row] of expectedMembers) {
    const observed = actualMembers.get(member);
    if (!observed) {
      comparisons.push({
        label: `${label}: missing ${member}`,
        expected: member,
        actual: null,
        difference: null,
        tolerance: 0,
        pass: false,
      });
      continue;
    }
    em.forEach((metric, ordinal) =>
      comparisons.push(
        numberComparison(
          `${label} ${member} · ${metric.name}`,
          row[metric.key],
          observed[am[ordinal].key],
          absolute,
          relative,
        ),
      ),
    );
  }
  for (const member of actualMembers.keys())
    if (!expectedMembers.has(member))
      comparisons.push({
        label: `${label}: unexpected member`,
        expected: null,
        actual: member,
        difference: null,
        tolerance: 0,
        pass: false,
      });
  return comparisons;
}
function independentParameterFilters(
  report: SavedReport,
  parameters: ReportParameterValues,
): QueryFilter[] {
  return report.definition.parameters.flatMap<QueryFilter>((parameter) => {
    const value = Object.hasOwn(parameters, parameter.id)
      ? parameters[parameter.id]
      : (parameter.default ?? null);
    if (value === null) return [];
    if (Array.isArray(value))
      return [
        { attribute: parameter.attribute, op: "in" as const, values: value },
      ];
    if (typeof value === "object")
      return [
        ...(value.from === undefined
          ? []
          : [
              {
                attribute: parameter.attribute,
                op: "gte" as const,
                value: value.from,
              },
            ]),
        ...(value.to === undefined
          ? []
          : [
              {
                attribute: parameter.attribute,
                op: "lte" as const,
                value: value.to,
              },
            ]),
      ];
    return [{ attribute: parameter.attribute, op: "eq" as const, value }];
  });
}
export interface IndependentReportContext {
  itemId: string;
  query: SemanticQuery;
  totals: { groupBy: AttributeRef[]; query: SemanticQuery }[];
  additive: string[];
}
/** Expected fields/filters are reconstructed without the report planner or parameter helper. */
export function independentReportContexts(
  report: SavedReport,
  parameters: ReportParameterValues,
  model: SemanticModel,
  views: ReportChecksInput["views"] = [],
): IndependentReportContext[] {
  const parameterFilters = independentParameterFilters(report, parameters);
  return report.definition.items.flatMap((item) => {
    if (!("data" in item)) return [];
    const source =
      item.data.kind === "fields"
        ? {
            rows: item.data.rows,
            columns: [] as AttributeRef[],
            values: item.data.values,
            filters: item.data.filters,
            sort: item.data.sort,
            topN: item.data.topN,
          }
        : views.find(
            (view) =>
              view.id === (item.data.kind === "view" ? item.data.viewId : ""),
          )?.config;
    if (!source)
      throw new Error(
        "A saved Explore view referenced by this report is missing.",
      );
    if (source.topN || (item.type === "table" && item.topNPerGroup))
      throw new UnsupportedReferenceError(
        "Top N report partitions are not an exhaustive partition of the source. The independent report verifier does not yet support Top N selection.",
      );
    const rows =
      item.type === "matrix"
        ? uniqueRefs(item.rows)
        : item.type === "table"
          ? uniqueRefs([
              ...item.groups,
              ...source.rows,
              ...(source.columns ?? []),
              ...item.columns.flatMap((c) =>
                c.binding.kind === "attribute" ? [c.binding.attribute] : [],
              ),
            ])
          : uniqueRefs(source.rows);
    const columns =
      item.type === "matrix"
        ? item.columns
        : item.type === "chart"
          ? (source.columns ?? [])
          : [];
    const measures =
      item.type === "matrix"
        ? uniqueStrings(item.values)
        : uniqueStrings([
            ...source.values,
            ...(item.type === "table"
              ? item.columns.flatMap((c) =>
                  c.binding.kind === "measure" ? [c.binding.measure] : [],
                )
              : []),
          ]);
    const filters = [...source.filters, ...parameterFilters];
    const query = { ...queryBase(), measures, rows, columns, filters };
    const totals: IndependentReportContext["totals"] = [];
    const add = (refs: AttributeRef[]) => {
      const groupBy = uniqueRefs(refs);
      if (
        !totals.some(
          (total) => JSON.stringify(total.groupBy) === JSON.stringify(groupBy),
        )
      )
        totals.push({
          groupBy,
          query: { ...query, rows: groupBy, columns: [] },
        });
    };
    if (item.type === "table") {
      if (item.subtotals)
        for (let n = 1; n <= item.groups.length; n++)
          add(item.groups.slice(0, n));
      if (item.grandTotal) add([]);
    }
    if (item.type === "matrix") {
      if (item.subtotals)
        for (let n = 1; n <= item.rows.length; n++) {
          add(item.rows.slice(0, n));
          add([...item.rows.slice(0, n), ...item.columns]);
        }
      if (item.grandTotal) {
        add(item.rows);
        add(item.columns);
        add([]);
      }
    }
    return [
      {
        itemId: item.id,
        query,
        totals,
        additive: measures.filter((ref) => isAdditiveMeasure(model, ref)),
      },
    ];
  });
}
function actualSql(observation: ReportObservation): string {
  return Object.values(observation.data.items)
    .flatMap((item) => [
      item.result.sql,
      ...(item.totals ?? []).map((total) => total.result.sql),
    ])
    .filter(Boolean)
    .join("\n\n-- next report context\n\n");
}
function canonicalMeasure(model: SemanticModel, ref: string): string {
  return (
    model.measures.find(
      (m) => m.id === ref || m.name.toLowerCase() === ref.toLowerCase(),
    )?.id ?? ref
  );
}
function attributeInfo(model: SemanticModel, ref: AttributeRef) {
  const table = model.tables.find(
    (t) =>
      t.id === ref.table ||
      t.name.toLowerCase() === ref.table.toLowerCase() ||
      t.sqlName.toLowerCase() === ref.table.toLowerCase(),
  );
  return table?.columns.find(
    (c) =>
      c.id === ref.column ||
      c.name.toLowerCase() === ref.column.toLowerCase() ||
      c.sqlName.toLowerCase() === ref.column.toLowerCase(),
  );
}
function equivalentAttribute(
  model: SemanticModel,
  a: AttributeRef,
  b: AttributeRef,
): boolean {
  const x = attributeInfo(model, a),
    y = attributeInfo(model, b);
  return x && y
    ? x.tableId === y.tableId && x.id === y.id
    : refKey(a) === refKey(b);
}
function displayMember(
  value: QueryValue | undefined,
  ref: AttributeRef,
  model: SemanticModel,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    if (
      Number.isInteger(value) &&
      (/\byear\b/i.test(attributeInfo(model, ref)?.name ?? "") ||
        (value >= 1900 && value <= 2200))
    )
      return String(value);
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
      value,
    );
  }
  return value;
}
function previewNumericReference(
  expected: NumericCells,
  report: SavedReport,
  context: IndependentReportContext,
  groupBy: AttributeRef[] | null,
  measure: string,
  columns: QueryResult["columns"],
  rows: QueryResult["rows"],
  model: SemanticModel,
): void {
  const item = report.definition.items.find(
    (item) => item.id === context.itemId,
  );
  if (!item) return;
  const metric = columns.find((c) => c.role === "measure");
  if (!metric) return;
  const attrs = columns.filter((c) => c.role === "attribute"),
    refs = groupBy ?? [...context.query.rows, ...(context.query.columns ?? [])],
    id = canonicalMeasure(model, measure),
    metricName = measureName(model, measure);
  const attrValue = (row: QueryResult["rows"][number], ref: AttributeRef) => {
    const index = refs.findIndex((candidate) =>
      equivalentAttribute(model, candidate, ref),
    );
    return index >= 0 ? (row[attrs[index]?.key] ?? null) : null;
  };
  const add = (field: string, value: QueryValue | undefined) => {
    const n = numeric(value);
    if (n !== null) (expected[item.id] ??= []).push({ field, value: n });
  };
  if (item.type === "chart") {
    if (groupBy) return;
    const max = item.viz === "donut" ? 50 : 200;
    if (rows.length > max) {
      throw new UnsupportedReferenceError(
        `${item.id}: chart exceeds its displayed-category bound; its query context was verified but not every rendered category.`,
      );
    }
    for (const row of rows) {
      const label =
        refs
          .map((ref) => displayMember(attrValue(row, ref), ref, model))
          .join(" / ") || "All data";
      add(`${id}|chart|${label}`, row[metric.key]);
    }
    return;
  }
  if (item.type === "table") {
    const copies = item.columns.filter(
      (c) =>
        c.binding.kind === "measure" &&
        canonicalMeasure(model, c.binding.measure) === id,
    ).length;
    if (!copies) return;
    const kind =
      groupBy === null ? "detail" : groupBy.length ? "subtotal" : "grandTotal";
    for (const row of rows) {
      const identity =
        kind === "detail"
          ? JSON.stringify(
              item.columns.flatMap((c) =>
                c.binding.kind === "attribute"
                  ? [attrValue(row, c.binding.attribute)]
                  : [],
              ),
            )
          : kind === "grandTotal"
            ? "Grand total"
            : `${(groupBy?.length ?? 1) - 1}|${attributeInfo(model, groupBy![groupBy!.length - 1])?.name ?? groupBy![groupBy!.length - 1].column}: ${displayMember(row[attrs[attrs.length - 1]?.key], groupBy![groupBy!.length - 1], model)} subtotal`;
      for (let copy = 0; copy < copies; copy++)
        add(`${id}|${kind}|${identity}`, row[metric.key]);
    }
    return;
  }
  if (item.type !== "matrix") return;
  const same = (a: AttributeRef[], b: AttributeRef[]) =>
    a.length === b.length &&
    a.every((ref, index) => equivalentAttribute(model, ref, b[index]));
  const all = [...item.rows, ...item.columns];
  const main = groupBy === null;
  if (!main && same(groupBy!, all)) return; // The leaf context is queried for completeness, not rendered twice.
  let kind: "detail" | "subtotal" | "grandTotal" = "detail",
    prefix = item.rows,
    asColumns = true;
  if (!main) {
    if (!groupBy!.length) {
      kind = "grandTotal";
      prefix = [];
      asColumns = false;
    } else if (same(groupBy!, item.columns)) {
      kind = "grandTotal";
      prefix = [];
    } else if (same(groupBy!, item.rows)) {
      prefix = item.rows;
      asColumns = false;
    } else {
      const width =
        groupBy!.length -
        (item.columns.length &&
        same(groupBy!.slice(-item.columns.length), item.columns)
          ? item.columns.length
          : 0);
      prefix = item.rows.slice(0, width);
      asColumns = width !== groupBy!.length;
      if (
        width < 1 ||
        width >= item.rows.length ||
        !same(groupBy!.slice(0, width), prefix)
      )
        return;
      kind = "subtotal";
    }
  }
  if (!asColumns && !item.grandTotal) return;
  for (const row of rows) {
    const identity =
      kind === "grandTotal"
        ? "Grand total"
        : kind === "detail"
          ? JSON.stringify(item.rows.map((ref) => attrValue(row, ref)))
          : `${prefix.length - 1}|${attributeInfo(model, prefix[prefix.length - 1])?.name ?? prefix[prefix.length - 1].column}: ${displayMember(attrValue(row, prefix[prefix.length - 1]), prefix[prefix.length - 1], model)} subtotal`;
    const header = asColumns
      ? `${item.columns.map((ref) => displayMember(attrValue(row, ref), ref, model)).join(" / ")} · ${metricName}`
      : `Total · ${metricName}`;
    add(`${id}|${kind}|${identity}|${header}`, row[metric.key]);
  }
}
/** Rendered numeric cells are bound independently to reference contexts. */
function observedPreviewNumeric(
  report: SavedReport,
  observation: ReportObservation,
  model: SemanticModel,
): NumericCells {
  const actual: NumericCells = Object.create(null) as NumericCells,
    headers = new Map<string, string[]>();
  let count = 0;
  const add = (
    itemId: string,
    field: string,
    value: QueryValue | undefined,
  ) => {
    const n = numeric(value);
    if (n !== null) {
      (actual[itemId] ??= []).push({ field, value: n });
      if (++count > MAX_CELLS)
        throw new UnsupportedReferenceError(
          "The rendered preview exceeds the verification cell bound.",
        );
    }
  };
  for (const page of observation.preview.pages)
    for (const element of page.elements) {
      if (element.kind === "tableHeader") {
        headers.set(
          element.itemId,
          element.cells.map((c) => c.text),
        );
        continue;
      }
      const item =
        "itemId" in element
          ? report.definition.items.find((item) => item.id === element.itemId)
          : undefined;
      if (element.kind === "chart" && item?.type === "chart") {
        for (const datum of element.data)
          for (const series of element.series)
            add(
              item.id,
              `${canonicalMeasure(model, series.label)}|chart|${datum.label}`,
              datum.values[series.key],
            );
        continue;
      }
      if (
        element.kind !== "tableRow" ||
        !item ||
        (item.type !== "table" && item.type !== "matrix")
      )
        continue;
      const identity =
        element.rowKind === "grandTotal"
          ? "Grand total"
          : element.rowKind === "subtotal"
            ? `${element.level ?? 0}|${element.label ?? ""}`
            : item.type === "table"
              ? JSON.stringify(
                  item.columns.flatMap((c, index) =>
                    c.binding.kind === "attribute"
                      ? [element.cells[index]?.raw ?? null]
                      : [],
                  ),
                )
              : JSON.stringify(
                  element.cells.slice(0, item.rows.length).map((c) => c.raw),
                );
      element.cells.forEach((cell, index) => {
        const field = cell.field;
        if (
          !field ||
          !model.measures.some(
            (m) =>
              m.id === field || m.name.toLowerCase() === field.toLowerCase(),
          )
        )
          return;
        const header =
          item.type === "matrix"
            ? `|${headers.get(item.id)?.[index] ?? ""}`
            : "";
        add(
          item.id,
          `${canonicalMeasure(model, field)}|${element.rowKind}|${identity}${header}`,
          cell.raw,
        );
      });
    }
  return actual;
}

async function compareReportToReferences(
  input: ReportChecksInput,
  report: SavedReport,
  parameters: ReportParameterValues,
  observation: ReportObservation,
  signal: AbortSignal,
) {
  const contexts = independentReportContexts(
    report,
    parameters,
    input.model,
    input.views,
  );
  const comparisons: ArtifactComparison[] = [],
    statements: string[] = [],
    unsupported: string[] = observation.preview.truncated
      ? [
          "The preview is truncated; full rendered numeric binding cannot be verified.",
        ]
      : [];
  const expectedPreview: NumericCells = Object.create(null) as NumericCells;
  const unsupportedPreviewItems = new Set<string>();
  const unsupportedPreviewMeasures = new Map<string, Set<string>>();
  for (const context of contexts) {
    signal.throwIfAborted();
    const actual = observation.data.items[context.itemId];
    if (!actual) {
      comparisons.push({
        label: `${context.itemId}: missing item`,
        expected: context.itemId,
        actual: null,
        difference: null,
        tolerance: 0,
        pass: false,
      });
      continue;
    }
    for (const [name, query, result, groupBy] of [
      ["detail", context.query, actual.result, null],
      ...context.totals.map(
        (total) =>
          [
            JSON.stringify(total.groupBy),
            total.query,
            actual.totals?.find(
              (candidate) =>
                JSON.stringify(candidate.groupBy) ===
                JSON.stringify(total.groupBy),
            )?.result,
            total.groupBy,
          ] as const,
      ),
    ] as const) {
      if (!result) {
        comparisons.push({
          label: `${context.itemId}: missing ${name}`,
          expected: "A server-generated total",
          actual: null,
          difference: null,
          tolerance: 0,
          pass: false,
        });
        continue;
      }
      for (const measure of query.measures) {
        let reference;
        try {
          reference = buildReferenceQuery(input.model, {
            ...query,
            measures: [measure],
          });
        } catch (error) {
          if (error instanceof UnsupportedReferenceError) {
            unsupported.push(`${context.itemId}/${measure}: ${error.message}`);
            const omitted =
              unsupportedPreviewMeasures.get(context.itemId) ??
              new Set<string>();
            omitted.add(canonicalMeasure(input.model, measure));
            unsupportedPreviewMeasures.set(context.itemId, omitted);
            continue;
          }
          throw error;
        }
        statements.push(reference.sql);
        const rows = await input.reference(reference, signal);
        try {
          comparisons.push(
            ...compareArtifactResults(
              {
                columns: reference.columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                elapsedMs: 0,
                fromCache: false,
                sql: reference.sql,
              },
              pickedResult(result, [measure], input.model),
              `${context.itemId} ${name} ${measure}`,
              input.absoluteTolerance,
              input.relativeTolerance,
            ),
          );
          previewNumericReference(
            expectedPreview,
            report,
            context,
            groupBy ?? null,
            measure,
            reference.columns,
            rows,
            input.model,
          );
        } catch (error) {
          if (error instanceof UnsupportedReferenceError) {
            unsupported.push(error.message);
            unsupportedPreviewItems.add(context.itemId);
            continue;
          }
          throw error;
        }
      }
    }
  }
  if (!observation.preview.truncated) {
    try {
      const actualPreview = observedPreviewNumeric(
        report,
        observation,
        input.model,
      );
      for (const [item, measures] of unsupportedPreviewMeasures)
        actualPreview[item] = (actualPreview[item] ?? []).filter(
          (cell) =>
            ![...measures].some((measure) =>
              cell.field.startsWith(`${measure}|`),
            ),
        );
      for (const id of unsupportedPreviewItems) {
        delete expectedPreview[id];
        delete actualPreview[id];
      }
      for (const comparison of compareNumericCellSets(
        expectedPreview,
        actualPreview,
        "Rendered preview vs independent SQL",
        input.absoluteTolerance ?? 0.01,
        input.relativeTolerance ?? 0.000001,
      ))
        comparisons.push(comparison);
    } catch (error) {
      if (!(error instanceof UnsupportedReferenceError)) throw error;
      unsupported.push(error.message);
    }
  }
  return { comparisons, statements, unsupported };
}
/** Only additive measures may be summed across a partition; AVG/ratios are excluded. */
export function reportSubtotalComparisons(
  report: SavedReport,
  observation: ReportObservation,
  model: SemanticModel,
  absolute = 0.01,
  relative = 0.000001,
): ArtifactComparison[] {
  const comparisons: ArtifactComparison[] = [];
  for (const item of report.definition.items) {
    if (item.type !== "table" && item.type !== "matrix") continue;
    const data = observation.data.items[item.id];
    if (!data || data.result.truncated) continue;
    const groups = item.type === "table" ? item.groups : item.rows;
    const first = data.totals?.find(
      (total) =>
        total.groupBy.length === 1 &&
        groups[0] &&
        refKey(total.groupBy[0]) === refKey(groups[0]),
    );
    const grand = data.totals?.find(
      (total) => total.groupBy.length === 0,
    )?.result;
    if (!first || !grand || first.result.truncated || grand.truncated) continue;
    for (const ref of (data.measures ?? []).filter((ref) =>
      isAdditiveMeasure(model, ref),
    )) {
      const groupColumn = first.result.columns.find(
        (c) =>
          c.role === "measure" &&
          c.name.toLowerCase() === measureName(model, ref).toLowerCase(),
      );
      const grandColumn = grand.columns.find(
        (c) =>
          c.role === "measure" &&
          c.name.toLowerCase() === measureName(model, ref).toLowerCase(),
      );
      if (!groupColumn || !grandColumn) {
        comparisons.push({
          label: `${item.id} ${ref}: missing total measure`,
          expected: "Requested measure",
          actual: null,
          difference: null,
          tolerance: 0,
          pass: false,
        });
        continue;
      }
      let sum = 0,
        count = 0;
      for (const row of first.result.rows) {
        const value = row[groupColumn.key];
        if (
          value !== null &&
          value !== undefined &&
          Number.isFinite(Number(value))
        ) {
          sum += Number(value);
          count++;
        }
      }
      comparisons.push(
        numberComparison(
          `${item.id} ${measureName(model, ref)}: first-level subtotals sum to grand total`,
          grand.rows[0]?.[grandColumn.key],
          count ? sum : null,
          absolute,
          relative,
        ),
      );
    }
  }
  return comparisons;
}
interface NumericCells {
  [itemId: string]: { field: string; value: number }[];
}
function numeric(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function previewCells(
  observation: ReportObservation,
  model: SemanticModel,
): {
  cells: NumericCells;
  headers: Map<string, { text: string; field: string }[]>;
  rowKinds: Map<string, string[]>;
} {
  const cells: NumericCells = Object.create(null) as NumericCells,
    headers = new Map<string, { text: string; field: string }[]>(),
    fullHeaders = new Map<string, string[]>(),
    rowKinds = new Map<string, string[]>();
  const names = new Set(model.measures.flatMap((m) => [m.id, m.name]));
  let count = 0;
  for (const page of observation.preview.pages)
    for (const element of page.elements) {
      if (element.kind === "tableHeader") {
        const labels = element.cells.map((cell) => cell.text || "Column");
        const prior = fullHeaders.get(element.itemId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(labels))
          throw new UnsupportedReferenceError(
            "The matrix preview spans multiple horizontal column bands. Export row order cannot be independently bound to the preview; narrow the matrix before reconciling exported cells.",
          );
        fullHeaders.set(element.itemId, labels);
        const existing = headers.get(element.itemId) ?? [];
        for (const cell of element.cells)
          if (
            cell.field &&
            names.has(cell.field) &&
            !existing.some(
              (e) => e.text === cell.text && e.field === cell.field,
            )
          )
            existing.push({ text: cell.text || "Column", field: cell.field });
        headers.set(element.itemId, existing);
      }
      if (element.kind !== "tableRow") continue;
      const list = (cells[element.itemId] ??= []);
      const numericCells = element.cells.flatMap((cell, index) => {
        if (cell.field && names.has(cell.field)) {
          const value = numeric(cell.raw);
          if (value !== null) return [{ field: cell.field, index, value }];
        }
        return [];
      });
      if (!numericCells.length) continue;
      const kinds = rowKinds.get(element.itemId) ?? [],
        ordinal = kinds.length;
      kinds.push(element.rowKind);
      rowKinds.set(element.itemId, kinds);
      for (const cell of numericCells) {
        list.push({
          field: `${cell.field}|column=${fullHeaders.get(element.itemId)?.[cell.index] ?? ""}|row=${ordinal}|kind=${element.rowKind}`,
          value: cell.value,
        });
        if (++count > MAX_CELLS)
          throw new UnsupportedReferenceError(
            "The preview exceeds the numeric-cell verification bound. Split the report into smaller reports.",
          );
      }
    }
  return { cells, headers, rowKinds };
}
function compareNumericCellSets(
  expected: NumericCells,
  actual: NumericCells,
  label: string,
  absolute: number,
  relative: number,
): ArtifactComparison[] {
  const comparisons: ArtifactComparison[] = [];
  for (const item of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    const group = (cells: NumericCells[string] | undefined) => {
      const values = new Map<string, number[]>();
      for (const cell of cells ?? []) {
        const list = values.get(cell.field) ?? [];
        list.push(cell.value);
        values.set(cell.field, list);
      }
      return values;
    };
    const expectedFields = group(expected[item]),
      actualFields = group(actual[item]);
    const fields = new Set([...expectedFields.keys(), ...actualFields.keys()]);
    for (const field of fields) {
      const e = (expectedFields.get(field) ?? []).sort((a, b) => a - b),
        a = (actualFields.get(field) ?? []).sort((a, b) => a - b);
      comparisons.push({
        label: `${label} ${item}/${field}: numeric cell count including totals`,
        expected: e.length,
        actual: a.length,
        difference: a.length - e.length,
        tolerance: 0,
        pass: e.length === a.length,
      });
      e.forEach((value, index) =>
        comparisons.push(
          numberComparison(
            `${label} ${item}/${field} value ${index + 1}`,
            value,
            a[index],
            absolute,
            relative,
          ),
        ),
      );
    }
  }
  return comparisons;
}
/** Independently read exported bytes; never call the exporter/tabular-row builder. */
export function reportExportComparisons(
  report: SavedReport,
  observation: ReportObservation,
  model: SemanticModel,
  format: "csv" | "xlsx",
  absolute = 0.01,
  relative = 0.000001,
): ArtifactComparison[] {
  if (observation.preview.truncated)
    throw new UnsupportedReferenceError(
      "The report preview is truncated, so its numeric row order cannot be compared with a complete export. Narrow the report before checking exported values.",
    );
  const bytes = observation[format];
  if (!bytes)
    throw new UnsupportedReferenceError(
      `The ${format.toUpperCase()} observation is unavailable; this export has not been verified.`,
    );
  if (bytes.byteLength > MAX_EXPORT_BYTES)
    throw new UnsupportedReferenceError(
      "The export exceeds the 16 MB verification budget; split the report before checking it.",
    );
  const {
    cells: expected,
    headers,
    rowKinds,
  } = previewCells(observation, model);
  const items = report.definition.items.filter(
    (item): item is Extract<ReportItem, { type: "table" | "matrix" }> =>
      item.type === "table" || item.type === "matrix",
  );
  const actual: NumericCells = Object.create(null) as NumericCells;
  const addRows = (
    item: (typeof items)[number],
    table: unknown[][],
    multipleCsv = false,
  ) => {
    const descriptors = headers.get(item.id) ?? [];
    if (!descriptors.length) return;
    const header = table[0]?.map((v) => String(v ?? "")) ?? [];
    const positions = descriptors.map((d) => ({
      ...d,
      index: header.indexOf(d.text),
    }));
    if (positions.some((p) => p.index < 0))
      throw new Error(
        `${format.toUpperCase()} omitted a preview measure column in ${item.title || item.id}.`,
      );
    if (
      positions.some(
        (p, i) => positions.findIndex((other) => other.index === p.index) !== i,
      )
    )
      throw new UnsupportedReferenceError(
        "Duplicate measure headers cannot be unambiguously reconciled in this export. Give each report column a unique label.",
      );
    const list = (actual[item.id] ??= []);
    let rows = 0,
      ordinal = 0;
    for (const row of table.slice(1)) {
      if (
        multipleCsv &&
        String(row[0] ?? "") !== (item.title || report.name || "Table")
      )
        continue;
      if (++rows > MAX_ROWS)
        throw new UnsupportedReferenceError(
          "The export exceeds the verification row bound; narrow the report.",
        );
      const numericCells = positions.flatMap((descriptor) => {
        const value = numeric(row[descriptor.index]);
        return value !== null ? [{ ...descriptor, value }] : [];
      });
      if (!numericCells.length) continue;
      const kind = rowKinds.get(item.id)?.[ordinal] ?? "extra";
      for (const cell of numericCells)
        list.push({
          field: `${cell.field}|column=${cell.text}|row=${ordinal}|kind=${kind}`,
          value: cell.value,
        });
      ordinal++;
    }
  };
  if (format === "csv") {
    const table = parseCsv(bytes, {
      bom: true,
      relax_column_count: false,
      max_record_size: 2 * 1024 * 1024,
    }) as string[][];
    if (
      items.length > 1 &&
      new Set(items.map((item) => item.title || report.name || "Table"))
        .size !== items.length
    )
      throw new UnsupportedReferenceError(
        "Multiple CSV tables have the same title and cannot be identified independently. Give saved report items unique titles.",
      );
    items.forEach((item) => addRows(item, table, items.length > 1));
  } else {
    const workbook = XLSX.read(bytes, {
      type: "array",
      sheetRows: MAX_ROWS + 2,
      cellDates: false,
    });
    items.forEach((item, index) => {
      const name = workbook.SheetNames[index];
      if (!name)
        throw new Error(
          `Excel omitted the worksheet for ${item.title || item.id}.`,
        );
      addRows(
        item,
        XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          header: 1,
          defval: null,
          raw: true,
        }) as unknown[][],
      );
    });
  }
  return compareNumericCellSets(
    expected,
    actual,
    format.toUpperCase(),
    absolute,
    relative,
  );
}
function defaultParameters(report: SavedReport): ReportParameterValues {
  return Object.fromEntries(
    report.definition.parameters.map((p) => [p.id, p.default ?? null]),
  );
}
export function createReportChecks(input: ReportChecksInput): CheckCase[] {
  if (!input.reports.length)
    return [
      safeArtifactCase(
        "reports:none",
        "Reports",
        "Saved report correctness",
        async () =>
          skipArtifact(
            "There are no saved reports to verify.",
            "Save a report with a table, matrix or chart, then run checks again.",
          ),
      ),
    ];
  const checks: CheckCase[] = [];
  for (const report of input.reports) {
    const defaults = defaultParameters(report),
      observations = new Map<string, Promise<ReportObservation>>();
    const observe = (values: ReportParameterValues, signal: AbortSignal) => {
      if (!input.observeReport)
        throw new UnsupportedReferenceError(
          "The report execution/export adapter is unavailable; saved report output has not been verified.",
        );
      const key = JSON.stringify(values);
      let pending = observations.get(key);
      if (!pending) {
        pending = input.observeReport(report, values, signal);
        observations.set(key, pending);
      }
      return pending;
    };
    checks.push(
      safeArtifactCase(
        `report:${report.id}:reference`,
        "Reports",
        `${report.name}: default parameters and server totals`,
        async (signal) => {
          const observation = await observe(defaults, signal),
            compared = await compareReportToReferences(
              input,
              report,
              defaults,
              observation,
              signal,
            );
          const outcome = artifactOutcome(
            compared.comparisons,
            "Report detail, subtotal and grand-total contexts were compared with separately constructed reference SQL; derived measures were re-evaluated, not summed.",
            actualSql(observation),
            compared.statements.join("\n\n"),
          );
          if (compared.unsupported.length) {
            outcome.explanation += ` ${compared.unsupported.length} contexts were unsupported: ${compared.unsupported.slice(0, 5).join("; ")}`;
            if (outcome.status === "pass") outcome.status = "warn";
          }
          return outcome;
        },
      ),
    );
    checks.push(
      safeArtifactCase(
        `report:${report.id}:subtotals`,
        "Reports",
        `${report.name}: additive subtotal reconciliation`,
        async (signal) => {
          const observation = await observe(defaults, signal);
          return artifactOutcome(
            reportSubtotalComparisons(
              report,
              observation,
              input.model,
              input.absoluteTolerance,
              input.relativeTolerance,
            ),
            "Only additive measures are summed across first-level groups. AVG, ratios, distinct counts and time intelligence are not treated as additive.",
            actualSql(observation),
          );
        },
      ),
    );
    for (const format of ["csv", "xlsx"] as const)
      checks.push(
        safeArtifactCase(
          `report:${report.id}:${format}`,
          "Reports",
          `${report.name}: ${format.toUpperCase()} equals preview`,
          async (signal) => {
            const observation = await observe(defaults, signal);
            return artifactOutcome(
              reportExportComparisons(
                report,
                observation,
                input.model,
                format,
                input.absoluteTolerance,
                input.relativeTolerance,
              ),
              `The actual ${format.toUpperCase()} bytes were read independently and their numeric detail/subtotal/grand-total cells compared with preview raw values; formatted strings were not re-parsed as money.`,
              actualSql(observation),
            );
          },
        ),
      );
    for (const parameter of report.definition.parameters)
      checks.push(
        safeArtifactCase(
          `report:${report.id}:parameter:${parameter.id}`,
          "Reports",
          `${report.name}: ${parameter.name} filter reconciliation`,
          async (signal) => {
            const contexts = independentReportContexts(
                report,
                defaults,
                input.model,
                input.views,
              ),
              main = contexts[0];
            if (!main)
              return skipArtifact(
                "This report has no numeric data item to filter.",
              );
            const all = {
              ...queryBase(),
              measures: [main.query.measures[0]],
              rows: [parameter.attribute],
              orderBy: [{ ref: parameter.attribute, dir: "asc" as const }],
              filters: main.query.filters.filter(
                (f) => refKey(f.attribute) !== refKey(parameter.attribute),
              ),
              limit: 2,
            };
            const current = defaults[parameter.id],
              alternatives: QueryFilter[][] =
                current !== null &&
                current !== undefined &&
                typeof current === "object" &&
                !Array.isArray(current)
                  ? [
                      ...(current.from !== null && current.from !== undefined
                        ? [
                            [
                              {
                                attribute: parameter.attribute,
                                op: "lt" as const,
                                value: current.from,
                              },
                            ],
                          ]
                        : []),
                      ...(current.to !== null && current.to !== undefined
                        ? [
                            [
                              {
                                attribute: parameter.attribute,
                                op: "gt" as const,
                                value: current.to,
                              },
                            ],
                          ]
                        : []),
                    ]
                  : current !== null && current !== undefined
                    ? [
                        [
                          {
                            attribute: parameter.attribute,
                            op: "notIn",
                            values: Array.isArray(current)
                              ? current
                              : [current],
                          },
                        ],
                      ]
                    : [];
            let selection = buildReferenceQuery(input.model, all),
              members: Record<string, QueryValue>[] = [];
            const selectionSql: string[] = [];
            // Prefer a genuinely different member; a default repeated as a
            // parameter would not exercise the filter-change path.
            for (const extra of [...alternatives, []]) {
              selection = buildReferenceQuery(input.model, {
                ...all,
                filters: [...all.filters, ...extra],
              });
              selectionSql.push(selection.sql);
              members = await input.reference(selection, signal);
              const member = selection.columns.find(
                (c) => c.role === "attribute",
              );
              if (
                member &&
                members.some(
                  (row) =>
                    row[member.key] !== null && row[member.key] !== undefined,
                )
              )
                break;
            }
            const column = selection.columns.find(
              (c) => c.role === "attribute",
            );
            const value = column
              ? members
                  .map((row) => row[column.key])
                  .find((v) => v !== null && v !== undefined)
              : undefined;
            if (value === undefined)
              return skipArtifact(
                "No non-null parameter member exists in the independent reference data.",
              );
            const values: ReportParameterValues = {
              ...defaults,
              [parameter.id]:
                parameter.type === "multi"
                  ? [value]
                  : parameter.type === "dateRange"
                    ? { from: value, to: value }
                    : value,
            };
            const observation = await observe(values, signal),
              compared = await compareReportToReferences(
                input,
                report,
                values,
                observation,
                signal,
              );
            const outcome = artifactOutcome(
              compared.comparisons,
              "A member selected from independent reference data was applied as a parameter. The resulting detail and totals were compared with hand-built parameter predicates; unchanged totals are allowed when the reference also predicts no change.",
              actualSql(observation),
              [...selectionSql, ...compared.statements].join("\n\n"),
            );
            if (compared.unsupported.length) {
              outcome.explanation += ` Unsupported contexts: ${compared.unsupported.slice(0, 5).join("; ")}`;
              if (outcome.status === "pass") outcome.status = "warn";
            }
            return outcome;
          },
        ),
      );
  }
  return checks;
}
