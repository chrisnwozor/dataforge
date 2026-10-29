import { createEmptyView, type ViewConfig } from "@/lib/explore/config";
import { createExpressionResolver, type ResolvedExpr } from "@/lib/semantic/expr";
import type { SemanticColumn, SemanticMeasure, SemanticModel, SemanticTable } from "@/lib/semantic/types";
import { createEmptyDashboard, dashboardDocumentSchema, type DashboardDocument, type DashboardTile } from "./schema";

interface Attribute { table: SemanticTable; column: SemanticColumn }
const fold = (value: string) => value.trim().toLocaleLowerCase("en-US");

function additiveMeasures(model: SemanticModel): SemanticMeasure[] {
  const resolver = createExpressionResolver(model);
  const measures: SemanticMeasure[] = [];
  for (const measure of model.measures) {
    try {
      let ast = resolver.resolveMeasure(measure.id).ast;
      while (ast.kind === "measure") ast = ast.expression;
      if (ast.kind !== "call" || !["SUM", "COUNT", "COUNT_BIG"].includes(ast.name)) continue;
      const argument = ast.args[0];
      if (argument?.kind === "column" && argument.table.id === model.factTableId || argument?.kind === "star" && ["COUNT", "COUNT_BIG"].includes(ast.name)) measures.push(measure);
      if (measures.length === 4) break;
    } catch { /* Invalid definitions do not become starter tiles. */ }
  }
  return measures;
}

function walk(node: ResolvedExpr, visit: (node: ResolvedExpr) => void): void {
  visit(node);
  if (node.kind === "measure") walk(node.expression, visit);
  else if (node.kind === "call") node.args.forEach((argument) => walk(argument, visit));
  else if (node.kind === "unary") walk(node.operand, visit);
  else if (node.kind === "binary") { walk(node.left, visit); walk(node.right, visit); }
  else if (node.kind === "in") { walk(node.expression, visit); node.values.forEach((value) => walk(value, visit)); }
}

function comparison(model: SemanticModel, base: SemanticMeasure): string | undefined {
  if (!model.date) return;
  const resolver = createExpressionResolver(model);
  const candidates = model.measures.filter((measure) => measure.id === `${base.id}:YoY` || /\b(?:yoy|year.over.year)\b/i.test(measure.name));
  for (const measure of candidates) {
    try {
      let referencesBase = false, referencesPriorYear = false;
      walk(resolver.resolveMeasure(measure.id).ast, (node) => {
        if (node.kind === "measure" && node.measure.id === base.id) referencesBase = true;
        if (node.kind === "call" && node.name === "SAMEPERIODLASTYEAR") referencesPriorYear = true;
      });
      if (referencesBase && referencesPriorYear) return measure.id;
    } catch { /* Invalid measures are not used to create a broken starter tile. */ }
  }
}

function calendarAttribute(model: SemanticModel): Attribute | undefined {
  const table = model.tables.find((entry) => entry.id === model.date?.tableId);
  if (!table) return;
  const year = table.columns.find((column) => column.role === "attribute" && fold(column.name) === "year");
  const month = table.columns.find((column) => column.role === "attribute" && fold(column.name) === "month")
    ?? table.columns.find((column) => column.role === "attribute" && fold(column.name) === "monthname");
  const column = year && !(typeof year.distinctCount === "number" && year.distinctCount < 3) ? year : month ?? year;
  return column ? { table, column } : undefined;
}

/** Business categories take precedence: the calendar already has its own trend tile. */
function rankedAttributes(model: SemanticModel): Attribute[] {
  const dimensions = model.tables.filter((table) => table.kind === "dimension");
  const business = dimensions.filter((table) => table.id !== model.date?.tableId);
  const tables = business.length ? business : dimensions;
  return tables.flatMap((table) => table.columns.filter((column) => column.role === "attribute" && typeof column.distinctCount === "number" && column.distinctCount > 0).map((column) => ({ table, column })))
    .sort((left, right) => left.column.distinctCount! - right.column.distinctCount! || left.table.name.localeCompare(right.table.name, "en-US") || left.column.name.localeCompare(right.column.name, "en-US") || left.column.id.localeCompare(right.column.id, "en-US"));
}

function view(viz: ViewConfig["viz"], measure: SemanticMeasure, attribute: Attribute, title: string): ViewConfig {
  const config = createEmptyView();
  const ref = { table: attribute.table.id, column: attribute.column.id };
  return {
    ...config, viz, rows: [ref], values: [measure.id],
    sort: [{ ref, dir: "asc" }],
    options: { ...config.options, title, showTotals: false, showLegend: false },
  };
}

function trendView(measure: SemanticMeasure, temporal: Attribute, title: string): ViewConfig {
  const config = view("line", measure, temporal, title);
  if (!fold(temporal.column.name).startsWith("month")) return config;
  const year = temporal.table.columns.find((column) => column.role === "attribute" && fold(column.name) === "year");
  if (!year) return config;
  // Month number alone would fold January in different years into one point.
  const rows = [{ table: temporal.table.id, column: year.id }, ...config.rows];
  return { ...config, rows, sort: rows.map((ref) => ({ ref, dir: "asc" as const })) };
}

/** Deterministic metadata-only starter. It neither issues queries nor guesses cardinality. */
export function generateStarterDashboard(model: SemanticModel): DashboardDocument {
  const document = createEmptyDashboard("Starter dashboard");
  document.description = "A starting point generated from the semantic model. Customize its layout, measures, and filters.";
  const additive = additiveMeasures(model);
  const measures = additive.slice(0, 4);
  const tiles: DashboardTile[] = [];
  let y = 0;
  if (measures.length) {
    const width = Math.floor(12 / measures.length);
    measures.forEach((measure, index) => {
      const comparisonMeasure = comparison(model, measure);
      tiles.push({ id: `starter-kpi-${index + 1}`, type: "kpi", x: index * width, y, w: width, h: 6, title: measure.name, subtitle: comparisonMeasure ? "Year-over-year comparison" : "Current filter context", numberFormat: "auto", showLegend: false, measure: measure.id, ...(comparisonMeasure ? { comparisonMeasure } : {}) });
    });
    y += 6;
  }
  const main = additive[0] ?? model.measures[0];
  const temporal = calendarAttribute(model);
  if (main && temporal) {
    const title = `${main.name} by ${temporal.column.name}`.slice(0, 200);
    tiles.push({ id: "starter-trend", type: "chart", x: 0, y, w: 12, h: 12, title, subtitle: "Trend over time", numberFormat: "auto", showLegend: false, source: { kind: "inline", config: trendView(main, temporal, title) } });
    y += 12;
  }
  const attributes = rankedAttributes(model);
  const bars = main ? attributes.filter((attribute) => attribute.column.distinctCount! <= 50).slice(0, 3) : [];
  if (main && bars.length) {
    const width = Math.floor(12 / bars.length);
    bars.forEach((attribute, index) => {
      const title = `${main.name} by ${attribute.column.name}`.slice(0, 200);
      tiles.push({ id: `starter-bar-${index + 1}`, type: "chart", x: index * width, y, w: width, h: 12, title, subtitle: `${attribute.table.name} · ${attribute.column.distinctCount} distinct values`, numberFormat: "auto", showLegend: false, source: { kind: "inline", config: view("bar", main, attribute, title) } });
    });
    y += 12;
  }
  const slicers = attributes.slice(0, 2);
  slicers.forEach((attribute, index) => tiles.push({ id: `starter-slicer-${index + 1}`, type: "slicer", x: index * 6, y, w: 6, h: 5, title: attribute.column.name, subtitle: "Filter the dashboard", numberFormat: "auto", showLegend: false, attribute: { table: attribute.table.id, column: attribute.column.id } }));
  if (!main || !tiles.length) tiles.push({ id: "starter-welcome", type: "text", x: 0, y: y + (slicers.length ? 5 : 0), w: 12, h: 5, title: "Start with a measure", subtitle: "Your dashboard is ready to edit", numberFormat: "auto", showLegend: false, content: "Add a measure in Measures, then add a chart or KPI tile. You can also add text and slicers to this dashboard." });
  return dashboardDocumentSchema.parse({ ...document, layout: { version: 1, tiles } });
}
