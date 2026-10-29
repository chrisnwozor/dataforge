import { z } from "zod";
import type { QueryFilter, QueryValue } from "@/lib/semantic/query/types";
import type { SemanticModel, SemanticType } from "@/lib/semantic/types";
import { reportParameterValuesSchema, type ReportDefinition, type ReportParameter, type ReportParameterValue, type ReportParameterValues } from "./schema";

const parametersOf = (definition: Pick<ReportDefinition, "parameters"> | readonly ReportParameter[]) => Array.isArray(definition) ? definition as readonly ReportParameter[] : (definition as Pick<ReportDefinition, "parameters">).parameters;
const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const scalar = (value: ReportParameterValue): value is QueryValue => value === null || typeof value !== "object";
const matchesType = (value: QueryValue, type: SemanticType) => value === null || type === "number" && typeof value === "number" || type === "boolean" && typeof value === "boolean" || type === "string" && typeof value === "string" || type === "date" && isoDate(value);

/** Validation is repeated on the server; parameters become typed filters, never SQL fragments. */
export function validateReportParameters(definition: Pick<ReportDefinition, "parameters"> | readonly ReportParameter[], input: unknown, model?: SemanticModel): ReportParameterValues {
  const parsed = reportParameterValuesSchema.parse(input);
  const parameters = parametersOf(definition);
  const known = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  const issues: z.core.$ZodIssue[] = [];
  const fail = (id: string, message: string) => issues.push({ code: "custom", path: [id], message });
  for (const key of Object.keys(parsed)) if (!known.has(key)) fail(key, "This report has no parameter with that ID.");
  const values: ReportParameterValues = {};
  for (const parameter of parameters) {
    const value = Object.hasOwn(parsed, parameter.id) ? parsed[parameter.id] : parameter.default ?? null;
    values[parameter.id] = value;
    const table = model?.tables.find((entry) => entry.id === parameter.attribute.table || entry.name === parameter.attribute.table || entry.sqlName === parameter.attribute.table);
    const column = table?.columns.find((entry) => entry.id === parameter.attribute.column || entry.name === parameter.attribute.column || entry.sqlName === parameter.attribute.column);
    if (model && (!column || column.role !== "attribute" || table?.kind !== "dimension")) fail(parameter.id, `${parameter.name} must bind to a dimension attribute.`);
    if (value === null) {
      if (!parameter.allowAll) fail(parameter.id, `${parameter.name} requires a value.`);
      continue;
    }
    if (parameter.type === "single" && (!scalar(value) || value === "")) fail(parameter.id, `${parameter.name} requires one value.`);
    if (parameter.type === "multi" && (!Array.isArray(value) || (!parameter.allowAll && value.length === 0))) fail(parameter.id, `${parameter.name} requires a list of values.`);
    if (parameter.type === "number" && typeof value !== "number") fail(parameter.id, `${parameter.name} requires a finite number.`);
    if (parameter.type === "text" && typeof value !== "string") fail(parameter.id, `${parameter.name} requires text.`);
    if (parameter.type === "dateRange") {
      if (scalar(value) || Array.isArray(value)) fail(parameter.id, `${parameter.name} requires a date range.`);
      else {
        if (value.from !== undefined && !isoDate(value.from) || value.to !== undefined && !isoDate(value.to)) fail(parameter.id, `${parameter.name} requires valid ISO dates (YYYY-MM-DD).`);
        if (typeof value.from === "string" && typeof value.to === "string" && value.from > value.to) fail(parameter.id, `${parameter.name} must start before it ends.`);
        if (!parameter.allowAll && value.from === undefined && value.to === undefined) fail(parameter.id, `${parameter.name} requires at least one date boundary.`);
      }
    }
    if (model && column && table?.kind === "dimension" && column.role === "attribute") {
        const members = Array.isArray(value) ? value : scalar(value) ? [value] : [value.from, value.to].filter((entry): entry is QueryValue => entry !== undefined);
        if (members.some((member) => !matchesType(member, column.type))) fail(parameter.id, `${parameter.name} values must have type ${column.type}.`);
    }
  }
  if (issues.length) throw new z.ZodError(issues);
  return values;
}

export function reportParameterFilters(definition: Pick<ReportDefinition, "parameters"> | readonly ReportParameter[], input: unknown, model?: SemanticModel): QueryFilter[] {
  const values = validateReportParameters(definition, input, model);
  return parametersOf(definition).flatMap((parameter): QueryFilter[] => {
    const value = values[parameter.id];
    if (value === null) return [];
    if (Array.isArray(value)) return [{ attribute: parameter.attribute, op: "in", values: value }];
    if (!scalar(value)) return [
      ...(value.from === undefined ? [] : [{ attribute: parameter.attribute, op: "gte" as const, value: value.from }]),
      ...(value.to === undefined ? [] : [{ attribute: parameter.attribute, op: "lte" as const, value: value.to }]),
    ];
    return [{ attribute: parameter.attribute, op: "eq", value }];
  });
}
export const parameterFilters = reportParameterFilters;

/** Reset all descendants, not only direct children, when a cascading parent changes. */
export function cascadeReportParameters(definition: Pick<ReportDefinition, "parameters"> | readonly ReportParameter[], current: ReportParameterValues, changedId: string, value: ReportParameterValue): ReportParameterValues {
  const parameters = parametersOf(definition);
  const changed = new Set([changedId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const parameter of parameters) if (parameter.dependsOn && changed.has(parameter.dependsOn) && !changed.has(parameter.id)) { changed.add(parameter.id); grew = true; }
  }
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.id === changedId ? value : changed.has(parameter.id) ? null : current[parameter.id] ?? parameter.default ?? null]));
}
export const cascadeParameters = cascadeReportParameters;

export function reportParameterSummary(definition: Pick<ReportDefinition, "parameters"> | readonly ReportParameter[], values: ReportParameterValues): string {
  return parametersOf(definition).map((parameter) => {
    const value = values[parameter.id] ?? parameter.default ?? null;
    const text = value === null ? "All" : Array.isArray(value) ? value.map((member) => member === null ? "(Empty)" : String(member)).join(", ") : typeof value === "object" ? `${value.from ?? "Any"} – ${value.to ?? "Any"}` : String(value);
    return `${parameter.name}: ${text}`;
  }).join(" · ");
}
