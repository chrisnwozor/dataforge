import type { ResolvedExpr } from "../expr";
import { resolveExpression } from "../expr";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
  SemanticType,
  SqlParameter,
} from "../types";
import type {
  AttributeRef,
  CompiledQuery,
  QueryFilter,
  QueryResultColumn,
  QueryValue,
} from "./types";
import { normalizeQuery } from "./schema";

export class QueryCompileError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "QueryCompileError";
  }
}

const quote = (name: string) => `[${name.replaceAll("]", "]]")}]`;
const qualified = (table: SemanticTable) =>
  `${quote(table.schema)}.${quote(table.sqlName)}`;
const fold = (value: string) => value.toLocaleLowerCase("en-US");
const aggregates = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "COUNT_BIG",
  "DISTINCTCOUNT",
]);
const timeFunctions = new Set([
  "YTD",
  "MTD",
  "QTD",
  "SAMEPERIODLASTYEAR",
  "PREVIOUSPERIOD",
]);
type ColumnRef = { table: SemanticTable; column: SemanticColumn };
type BoundFilter = QueryFilter & { resolved: ColumnRef };
type RenderContext = {
  filters: ResolvedExpr[];
  ignored: Set<string>;
  window?: { start: string; end: string };
};

function filterColumns(node: ResolvedExpr): Set<string> {
  const ids = new Set<string>();
  walk(node, (child) => {
    if (child.kind === "column") ids.add(child.column.id);
  });
  return ids;
}

function findOne<T>(
  values: T[],
  name: string,
  id: (value: T) => string,
  names: (value: T) => string[],
  kind: string,
): T {
  const exact = values.find((value) => id(value) === name);
  if (exact) return exact;
  const matches = values.filter((value) =>
    names(value).some((candidate) => fold(candidate) === fold(name)),
  );
  if (matches.length !== 1)
    throw new QueryCompileError(
      matches.length
        ? `The ${kind} reference is ambiguous: ${name}. Use its ID.`
        : `Unknown ${kind}: ${name}.`,
    );
  return matches[0];
}

export function resolveAttribute(
  model: SemanticModel,
  ref: AttributeRef,
  allowMeasureSource = false,
): ColumnRef {
  const table = findOne(
    model.tables,
    ref.table,
    (value) => value.id,
    (value) => [value.name, value.sqlName],
    "table",
  );
  const column = findOne(
    table.columns,
    ref.column,
    (value) => value.id,
    (value) => [value.name, value.sqlName],
    "column",
  );
  if (column.role === "measure-source" && !allowMeasureSource)
    throw new QueryCompileError(
      `${column.name} is a measure source. Select a measure instead of grouping this numeric source.`,
    );
  return { table, column };
}

function resolveMeasure(model: SemanticModel, ref: string): SemanticMeasure {
  return findOne(
    model.measures,
    ref,
    (value) => value.id,
    (value) => [value.name],
    "measure",
  );
}

function walk(node: ResolvedExpr, visit: (node: ResolvedExpr) => void): void {
  visit(node);
  switch (node.kind) {
    case "measure":
      walk(node.expression, visit);
      break;
    case "unary":
      walk(node.operand, visit);
      break;
    case "binary":
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case "in":
      walk(node.expression, visit);
      node.values.forEach((value) => walk(value, visit));
      break;
    case "call":
      node.args.forEach((value) => walk(value, visit));
      break;
  }
}

/** Every identifier comes from the validated semantic model; values are always parameters. */
class SqlBuilder {
  readonly params: SqlParameter[] = [];
  readonly usedColumns = new Map<string, ColumnRef>();
  readonly usedTables = new Set<string>();
  private aliases = new Map<string, string>();
  private flatAliases = new Map<string, string>();
  readonly fact: SemanticTable;

  constructor(
    readonly model: SemanticModel,
    readonly hideUnknown: boolean,
  ) {
    const fact = model.tables.find(
      (table) => table.id === model.factTableId && table.kind === "fact",
    );
    if (!fact)
      throw new QueryCompileError("The semantic model has no fact table.");
    this.fact = fact;
    this.aliases.set(fact.id, "f");
  }

  addColumn(ref: ColumnRef) {
    this.usedTables.add(ref.table.id);
    this.usedColumns.set(ref.column.id, ref);
  }

  addExpression(node: ResolvedExpr) {
    walk(node, (child) => {
      if (child.kind === "column") this.addColumn(child);
      if (child.kind === "call" && timeFunctions.has(child.name)) {
        const date = this.model.date;
        if (!date)
          throw new QueryCompileError(
            `${child.name} requires a generated date dimension.`,
          );
        const table = this.model.tables.find(
          (candidate) => candidate.id === date.tableId,
        );
        const column = table?.columns.find(
          (candidate) => candidate.id === date.dateColumnId,
        );
        if (!table || !column)
          throw new QueryCompileError(
            "The semantic calendar relationship is invalid.",
          );
        this.addColumn({ table, column });
      }
    });
  }

  param(value: QueryValue, type?: SemanticType): string {
    if (this.params.length >= 1_999)
      throw new QueryCompileError(
        "The query uses too many parameter values. Reduce the number of filters or selected measures.",
      );
    const name = `p${this.params.length}`;
    this.params.push({ name, value, ...(type ? { type } : {}) });
    return `@${name}`;
  }

  prepare() {
    let index = 0;
    for (const table of this.model.tables)
      if (this.usedTables.has(table.id) && table.id !== this.fact.id)
        this.aliases.set(table.id, `d${index++}`);
    index = 0;
    for (const id of this.usedColumns.keys())
      this.flatAliases.set(id, `c${index++}`);
  }

  column(ref: ColumnRef, flatAlias?: string): string {
    if (flatAlias) {
      const flat = this.flatAliases.get(ref.column.id);
      if (!flat)
        throw new QueryCompileError(
          "An expression references a column outside the query model.",
        );
      return `${quote(flatAlias)}.${quote(flat)}`;
    }
    const alias = this.aliases.get(ref.table.id);
    if (!alias)
      throw new QueryCompileError(
        "An expression references an unjoined table.",
      );
    return `${quote(alias)}.${quote(ref.column.sqlName)}`;
  }

  private relationship(table: SemanticTable) {
    const links = this.model.relationships.filter(
      (link) =>
        link.fromTableId === this.fact.id &&
        link.toTableId === table.id &&
        link.cardinality === "many-to-one",
    );
    const link =
      links.find(
        (candidate) =>
          table.id === this.model.date?.tableId &&
          candidate.fromColumnId === this.model.date.factColumnId,
      ) ?? links[0];
    const source = this.fact.columns.find(
      (column) => column.id === link?.fromColumnId,
    );
    const target = table.columns.find(
      (column) => column.id === link?.toColumnId,
    );
    if (!link || !source || !target)
      throw new QueryCompileError(
        `The dimension ${table.name} has no valid fact relationship.`,
      );
    return { source, target };
  }

  from(): { from: string; unknown: string[] } {
    let from = `${qualified(this.fact)} AS [f]`;
    const unknown: string[] = [];
    for (const table of this.model.tables) {
      if (table.id === this.fact.id || !this.usedTables.has(table.id)) continue;
      const { source, target } = this.relationship(table);
      from += `\n  LEFT JOIN ${qualified(table)} AS ${quote(this.aliases.get(table.id)!)} ON [f].${quote(source.sqlName)} = ${this.column({ table, column: target })}`;
      if (this.hideUnknown) unknown.push(`[f].${quote(source.sqlName)} <> -1`);
    }
    return { from, unknown };
  }

  baseProjection(): string {
    if (!this.usedColumns.size)
      return (
        "[f]." +
        quote(
          this.fact.columns.find(
            (column) => column.id === this.fact.keyColumnId,
          )?.sqlName ?? "__invalid_key",
        ) +
        " AS [__df_fact_key]"
      );
    return [...this.usedColumns.values()]
      .map(
        (ref) =>
          `${this.column(ref)} AS ${quote(this.flatAliases.get(ref.column.id)!)}`,
      )
      .join(",\n    ");
  }

  filter(filter: BoundFilter, alias?: string): string {
    const column = this.column(filter.resolved, alias);
    const value = (input: QueryValue): string => {
      if (input !== null) {
        const type = filter.resolved.column.type;
        if (
          (type === "number" && typeof input !== "number") ||
          (type === "boolean" && typeof input !== "boolean") ||
          ((type === "string" || type === "date") && typeof input !== "string")
        )
          throw new QueryCompileError(
            `Filter values for ${filter.resolved.column.name} must have type ${type}.`,
          );
        if (
          type === "date" &&
          (typeof input !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(input) ||
            !Number.isFinite(Date.parse(input)) ||
            new Date(input).toISOString().slice(0, 10) !== input)
        )
          throw new QueryCompileError(
            `Enter a valid ISO date (YYYY-MM-DD) for ${filter.resolved.column.name}.`,
          );
      }
      return this.param(input, filter.resolved.column.type);
    };
    if (filter.op === "isNull") return `${column} IS NULL`;
    if (filter.op === "isNotNull") return `${column} IS NOT NULL`;
    if (filter.op === "in" || filter.op === "notIn") {
      const values = filter.values!;
      const nonNull = values.filter((entry) => entry !== null);
      const hasNull = nonNull.length !== values.length;
      const list = nonNull.length
        ? `${column} ${filter.op === "notIn" ? "NOT IN" : "IN"} (${nonNull.map(value).join(", ")})`
        : "";
      const nullTest = hasNull
        ? `${column} IS ${filter.op === "notIn" ? "NOT " : ""}NULL`
        : "";
      return list && nullTest
        ? `(${list} ${filter.op === "notIn" ? "AND" : "OR"} ${nullTest})`
        : list || nullTest || (filter.op === "in" ? "1 = 0" : "1 = 1");
    }
    if (filter.value === null) {
      if (filter.op !== "eq" && filter.op !== "ne")
        throw new QueryCompileError(
          "NULL supports only equality, inequality, or null checks.",
        );
      return `${column} IS ${filter.op === "ne" ? "NOT " : ""}NULL`;
    }
    const op = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[
      filter.op
    ];
    return `${column} ${op} ${value(filter.value!)}`;
  }
}

function isPredicate(node: ResolvedExpr): boolean {
  return (
    node.kind === "in" ||
    (node.kind === "unary" && node.op === "NOT") ||
    (node.kind === "binary" &&
      ["=", "<>", "!=", "<", ">", "<=", ">=", "AND", "OR"].includes(node.op))
  );
}

class ExpressionSql {
  constructor(
    readonly builder: SqlBuilder,
    readonly groups: ColumnRef[],
    readonly queryFilters: BoundFilter[],
    readonly correlated: boolean,
    readonly groupAliases: Map<string, string>,
  ) {}

  predicate(
    node: ResolvedExpr,
    context: RenderContext,
    alias?: string,
  ): string {
    return isPredicate(node)
      ? this.render(node, context, alias, true)
      : `(${this.render(node, context, alias)} = CAST(1 AS BIT))`;
  }

  private aggregate(
    name: string,
    argument: ResolvedExpr,
    context: RenderContext,
  ): string {
    const alias = this.correlated ? "b" : undefined;
    const star = argument.kind === "star";
    const source = star ? "1" : this.render(argument, context, alias);
    const conditions = context.filters.map((filter) =>
      this.predicate(filter, context, alias),
    );
    const filtered = conditions.length
      ? `CASE WHEN ${conditions.join(" AND ")} THEN ${source} END`
      : source;
    const aggregate =
      name === "DISTINCTCOUNT"
        ? `COUNT_BIG(DISTINCT ${filtered})`
        : name === "COUNT" || name === "COUNT_BIG"
          ? `COUNT_BIG(${star && !conditions.length ? "*" : filtered})`
          : `${name}(${name === "AVG" ? `CAST(${filtered} AS FLOAT)` : name === "SUM" ? `CAST(${filtered} AS DECIMAL(38, 10))` : filtered})`;
    if (!this.correlated) return aggregate;
    const where = this.scope(context);
    return `(SELECT ${aggregate} FROM [__df_base] AS [b]${where.length ? ` WHERE ${where.join(" AND ")}` : ""})`;
  }

  private scope(context: RenderContext): string[] {
    const where = this.queryFilters
      .filter(
        (filter) =>
          !context.ignored.has(filter.resolved.column.id) &&
          !(
            context.window &&
            filter.resolved.table.id === this.builder.model.date?.tableId
          ),
      )
      .map((filter) => this.builder.filter(filter, "b"));
    for (const group of this.groups) {
      if (
        context.ignored.has(group.column.id) ||
        (context.window && group.table.id === this.builder.model.date?.tableId)
      )
        continue;
      const inner = this.builder.column(group, "b");
      const outer = `[g].${quote(this.groupAliases.get(group.column.id)!)}`;
      where.push(
        `(${inner} = ${outer} OR (${inner} IS NULL AND ${outer} IS NULL))`,
      );
    }
    if (context.window) {
      const date = this.builder.model.date!;
      const table = this.builder.model.tables.find(
        (candidate) => candidate.id === date.tableId,
      )!;
      const column = table.columns.find(
        (candidate) => candidate.id === date.dateColumnId,
      )!;
      where.push(
        `${this.builder.column({ table, column }, "b")} >= ${context.window.start}`,
        `${this.builder.column({ table, column }, "b")} <= ${context.window.end}`,
      );
    }
    return where;
  }

  private timeContext(
    name: string,
    node: ResolvedExpr & { kind: "call" },
    context: RenderContext,
  ): RenderContext {
    let start = context.window?.start ?? "[g].[__df_start]";
    let end = context.window?.end ?? "[g].[__df_end]";
    if (!context.window && (context.filters.length || context.ignored.size)) {
      const date = this.builder.model.date!;
      const table = this.builder.model.tables.find(
        (candidate) => candidate.id === date.tableId,
      )!;
      const column = table.columns.find(
        (candidate) => candidate.id === date.dateColumnId,
      )!;
      const scope = [
        ...this.scope(context),
        ...context.filters.map((filter) =>
          this.predicate(filter, context, "b"),
        ),
      ];
      const from = `FROM [__df_base] AS [b]${scope.length ? ` WHERE ${scope.join(" AND ")}` : ""}`;
      start = `(SELECT MIN(${this.builder.column({ table, column }, "b")}) ${from})`;
      end = `(SELECT MAX(${this.builder.column({ table, column }, "b")}) ${from})`;
    }
    const month = `DATEFROMPARTS(YEAR(${end}), MONTH(${end}), 1)`;
    const quarter = `DATEFROMPARTS(YEAR(${end}), ((MONTH(${end}) - 1) / 3) * 3 + 1, 1)`;
    const year = `DATEFROMPARTS(YEAR(${end}), 1, 1)`;
    let window = { start, end };
    if (name === "YTD") window = { start: year, end };
    else if (name === "MTD") window = { start: month, end };
    else if (name === "QTD") window = { start: quarter, end };
    else if (name === "SAMEPERIODLASTYEAR")
      window = {
        start: `DATEADD(YEAR, -1, ${start})`,
        end: `DATEADD(YEAR, -1, ${end})`,
      };
    else {
      const period = node.args[1];
      if (period.kind !== "period")
        throw new QueryCompileError(
          "PREVIOUSPERIOD requires MONTH, QUARTER, or YEAR.",
        );
      const beginning =
        period.value === "MONTH"
          ? month
          : period.value === "QUARTER"
            ? quarter
            : year;
      window = {
        start: `DATEADD(${period.value}, -1, ${beginning})`,
        end: `DATEADD(DAY, -1, ${beginning})`,
      };
    }
    if (window.start.length > 262_144 || window.end.length > 262_144)
      throw new QueryCompileError(
        "The compiled time expression is too complex (maximum 256 KiB).",
      );
    const dateTable = this.builder.model.tables.find(
      (table) => table.id === this.builder.model.date?.tableId,
    )!;
    const dateColumns = new Set(dateTable.columns.map((column) => column.id));
    return {
      ...context,
      filters: context.filters.filter(
        (filter) =>
          ![...filterColumns(filter)].some((id) => dateColumns.has(id)),
      ),
      window,
    };
  }

  render(
    node: ResolvedExpr,
    context: RenderContext,
    columnAlias?: string,
    predicate = false,
  ): string {
    const sql = this.renderNode(node, context, columnAlias, predicate);
    if (sql.length > 262_144)
      throw new QueryCompileError(
        "The compiled measure is too complex (maximum 256 KiB of SQL).",
      );
    return sql;
  }

  private renderNode(
    node: ResolvedExpr,
    context: RenderContext,
    columnAlias?: string,
    predicate = false,
  ): string {
    if (!predicate && isPredicate(node)) {
      const condition = this.render(node, context, columnAlias, true);
      return `(CASE WHEN ${condition} THEN CAST(1 AS BIT) WHEN NOT (${condition}) THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`;
    }
    switch (node.kind) {
      case "literal":
        return this.builder.param(node.value);
      case "column":
        return this.builder.column(node, columnAlias);
      case "measure":
        return this.render(node.expression, context, columnAlias, predicate);
      case "star":
        return "*";
      case "period":
        throw new QueryCompileError(
          "A time period can only be used by PREVIOUSPERIOD.",
        );
      case "unary":
        return node.op === "NOT"
          ? `(NOT ${this.predicate(node.operand, context, columnAlias)})`
          : `(${node.op}${this.render(node.operand, context, columnAlias)})`;
      case "in": {
        const left = this.render(node.expression, context, columnAlias);
        const nonNull = node.values.filter(
          (value) => !(value.kind === "literal" && value.value === null),
        );
        const hasNull = nonNull.length !== node.values.length;
        const list = nonNull.length
          ? `${left} ${node.negated ? "NOT IN" : "IN"} (${nonNull.map((value) => this.render(value, context, columnAlias)).join(", ")})`
          : "";
        const nullTest = hasNull
          ? `${left} IS ${node.negated ? "NOT " : ""}NULL`
          : "";
        return list && nullTest
          ? `(${list} ${node.negated ? "AND" : "OR"} ${nullTest})`
          : `(${list || nullTest || (node.negated ? "1 = 1" : "1 = 0")})`;
      }
      case "binary": {
        if (node.op === "AND" || node.op === "OR")
          return `(${this.predicate(node.left, context, columnAlias)} ${node.op} ${this.predicate(node.right, context, columnAlias)})`;
        const left = this.render(node.left, context, columnAlias);
        const right = this.render(node.right, context, columnAlias);
        if (
          (node.op === "=" || node.op === "<>" || node.op === "!=") &&
          ((node.left.kind === "literal" && node.left.value === null) ||
            (node.right.kind === "literal" && node.right.value === null))
        ) {
          const other =
            node.left.kind === "literal" && node.left.value === null
              ? right
              : left;
          return `(${other} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
        }
        if (node.op === "/")
          return `(CAST(${left} AS DECIMAL(38, 10)) / NULLIF(${right}, 0))`;
        if (node.op === "%") return `(${left} % NULLIF(${right}, 0))`;
        const allowed: Record<string, string> = {
          "+": "+",
          "-": "-",
          "*": "*",
          "=": "=",
          "!=": "<>",
          "<>": "<>",
          "<": "<",
          ">": ">",
          "<=": "<=",
          ">=": ">=",
        };
        const operator = allowed[node.op];
        if (!operator)
          throw new QueryCompileError("Unsupported expression operator.");
        return `(${left} ${operator} ${right})`;
      }
      case "call": {
        if (aggregates.has(node.name))
          return this.aggregate(node.name, node.args[0], context);
        if (node.name === "CALCULATE") {
          const next: RenderContext = {
            ...context,
            filters: [...context.filters],
            ignored: new Set(context.ignored),
          };
          for (const filter of node.args.slice(1)) {
            const ids = filterColumns(filter);
            next.filters = next.filters.filter(
              (previous) =>
                ![...filterColumns(previous)].some((id) => ids.has(id)),
            );
            for (const id of ids) next.ignored.add(id);
            if (!(filter.kind === "call" && filter.name === "ALL"))
              next.filters.push(filter);
          }
          return this.render(node.args[0], next, columnAlias);
        }
        if (timeFunctions.has(node.name))
          return this.render(
            node.args[0],
            this.timeContext(node.name, node, context),
            columnAlias,
          );
        if (node.name === "DIVIDE") {
          const numerator = this.render(node.args[0], context, columnAlias);
          const denominator = this.render(node.args[1], context, columnAlias);
          return `(CASE WHEN ${denominator} IS NULL OR ${denominator} = 0 THEN ${node.args[2] ? this.render(node.args[2], context, columnAlias) : "NULL"} ELSE CAST(${numerator} AS FLOAT) / NULLIF(${denominator}, 0) END)`;
        }
        if (node.name === "IF")
          return `(CASE WHEN ${this.predicate(node.args[0], context, columnAlias)} THEN ${this.render(node.args[1], context, columnAlias)} ELSE ${this.render(node.args[2], context, columnAlias)} END)`;
        if (node.name === "ABS")
          return `ABS(${this.render(node.args[0], context, columnAlias)})`;
        if (node.name === "ROUND")
          return `ROUND(${this.render(node.args[0], context, columnAlias)}, ${this.render(node.args[1], context, columnAlias)})`;
        throw new QueryCompileError(
          `Unsupported expression function: ${node.name}.`,
        );
      }
    }
  }
}

function compileCheckedQuery(
  model: SemanticModel,
  input: unknown,
): CompiledQuery {
  const query = normalizeQuery(input);
  const measures = query.measures.map((ref) => resolveMeasure(model, ref));
  if (new Set(measures.map((measure) => measure.id)).size !== measures.length)
    throw new QueryCompileError("Choose each measure only once.");
  const rows = query.rows.map((ref) => resolveAttribute(model, ref));
  const pivotColumns = (query.columns ?? []).map((ref) =>
    resolveAttribute(model, ref),
  );
  const groups = [...rows, ...pivotColumns];
  if (new Set(groups.map((ref) => ref.column.id)).size !== groups.length)
    throw new QueryCompileError("Choose each grouping attribute only once.");
  const filters: BoundFilter[] = query.filters.map((filter) => ({
    ...filter,
    resolved: resolveAttribute(model, filter.attribute, true),
  }));
  const checked = measures.map((measure) =>
    resolveExpression(measure.expression, model),
  );
  const expressions = checked.map((expression) => expression.ast);
  const builder = new SqlBuilder(model, query.hideUnknown);
  groups.forEach((ref) => builder.addColumn(ref));
  filters.forEach((filter) => builder.addColumn(filter.resolved));
  expressions.forEach((expression) => builder.addExpression(expression));
  builder.prepare();
  let correlated = false;
  let usesTime = false;
  const groupAliases = new Map(
    groups.map((ref, index) => [ref.column.id, `a${index}`]),
  );
  const measureAliases = new Map(
    measures.map((measure, index) => [measure.id, `m${index}`]),
  );
  const queryContextColumns = new Set([
    ...groups.map((ref) => ref.column.id),
    ...filters.map((filter) => filter.resolved.column.id),
  ]);
  expressions.forEach((expression) =>
    walk(expression, (node) => {
      if (
        node.kind === "call" &&
        (node.name === "ALL" || timeFunctions.has(node.name))
      )
        correlated = true;
      if (node.kind === "call" && timeFunctions.has(node.name)) usesTime = true;
      if (
        node.kind === "call" &&
        node.name === "CALCULATE" &&
        node.args
          .slice(1)
          .some((filter) =>
            [...filterColumns(filter)].some((id) =>
              queryContextColumns.has(id),
            ),
          )
      )
        correlated = true;
    }),
  );
  const renderer = new ExpressionSql(
    builder,
    groups,
    filters,
    correlated,
    groupAliases,
  );
  const context: RenderContext = { filters: [], ignored: new Set() };
  const { from, unknown } = builder.from();
  const columns: QueryResultColumn[] = [
    ...groups.map(({ column }) => ({
      key: groupAliases.get(column.id)!,
      name: column.name,
      type: column.type,
      role: "attribute" as const,
    })),
    ...measures.map((measure, index) => ({
      key: measureAliases.get(measure.id)!,
      name: measure.name,
      type: (["number", "string", "boolean", "date"].includes(
        checked[index].type,
      )
        ? checked[index].type
        : "number") as SemanticType,
      role: "measure" as const,
    })),
  ];
  if (new Set(columns.map((column) => column.key)).size !== columns.length)
    throw new QueryCompileError(
      "Semantic column and measure IDs must be unique.",
    );
  const ctes: string[] = [];
  if (correlated) {
    ctes.push(
      `[__df_base] AS (\n  SELECT ${builder.baseProjection()}\n  FROM ${from}${unknown.length ? `\n  WHERE ${unknown.join(" AND ")}` : ""}\n)`,
    );
    const groupProjection = groups.map(
      (ref) =>
        `${builder.column(ref, "b")} AS ${quote(groupAliases.get(ref.column.id)!)}`,
    );
    if (usesTime) {
      const date = model.date!;
      const table = model.tables.find(
        (candidate) => candidate.id === date.tableId,
      )!;
      const column = table.columns.find(
        (candidate) => candidate.id === date.dateColumnId,
      )!;
      groupProjection.push(
        `MIN(${builder.column({ table, column }, "b")}) AS [__df_start]`,
        `MAX(${builder.column({ table, column }, "b")}) AS [__df_end]`,
      );
    } else groupProjection.push("COUNT_BIG(*) AS [__df_group_count]");
    const where = filters.map((filter) => builder.filter(filter, "b"));
    ctes.push(
      `[__df_groups] AS (\n  SELECT ${groupProjection.join(", ")}\n  FROM [__df_base] AS [b]${where.length ? `\n  WHERE ${where.join(" AND ")}` : ""}${groups.length ? `\n  GROUP BY ${groups.map((ref) => builder.column(ref, "b")).join(", ")}` : ""}\n)`,
    );
    ctes.push(
      `[__df_result] AS (\n  SELECT ${[...groups.map((ref) => `[g].${quote(groupAliases.get(ref.column.id)!)}`), ...expressions.map((expression, index) => `${renderer.render(expression, context)} AS ${quote(measureAliases.get(measures[index].id)!)}`)].join(",\n    ")}\n  FROM [__df_groups] AS [g]\n)`,
    );
  } else {
    const where = [
      ...unknown,
      ...filters.map((filter) => builder.filter(filter)),
    ];
    ctes.push(
      `[__df_result] AS (\n  SELECT ${[
        ...groups.map(
          (ref) =>
            `${builder.column(ref)} AS ${quote(groupAliases.get(ref.column.id)!)}`,
        ),
        ...expressions.map(
          (expression, index) =>
            `${renderer.render(expression, context)} AS ${quote(measureAliases.get(measures[index].id)!)}`,
        ),
        "COUNT_BIG(*) AS [__df_group_count]",
      ].join(
        ",\n    ",
      )}\n  FROM ${from}${where.length ? `\n  WHERE ${where.join(" AND ")}` : ""}${groups.length ? `\n  GROUP BY ${groups.map((ref) => builder.column(ref)).join(", ")}` : ""}\n)`,
    );
  }
  let resultName = "__df_result";
  if (pivotColumns.length) {
    ctes.push(
      `[__df_ranked] AS (\n  SELECT [r].*, DENSE_RANK() OVER (ORDER BY ${pivotColumns.map((ref) => `[r].${quote(groupAliases.get(ref.column.id)!)}`).join(", ")}) AS [__df_pivot_rank]\n  FROM [__df_result] AS [r]\n)`,
    );
    ctes.push(
      "[__df_pivot] AS (\n  SELECT [r].*, MAX([r].[__df_pivot_rank]) OVER () AS [__df_pivot_total]\n  FROM [__df_ranked] AS [r]\n)",
    );
    resultName = "__df_pivot";
  }
  const order: string[] = [];
  const resolveOrder = (ref: string | AttributeRef): string => {
    if (typeof ref === "string") {
      const exact = measureAliases.get(ref) ?? groupAliases.get(ref);
      if (exact) return exact;
      const named = columns.filter((column) => fold(column.name) === fold(ref));
      if (named.length === 1) return named[0].key;
      throw new QueryCompileError(
        "Order by a selected measure or grouping attribute.",
      );
    }
    const resolved = resolveAttribute(model, ref);
    if (!groups.some((group) => group.column.id === resolved.column.id))
      throw new QueryCompileError(
        "Order attributes must also be selected as grouping attributes.",
      );
    return groupAliases.get(resolved.column.id)!;
  };
  if (query.topN) {
    const topMeasure = resolveMeasure(model, query.topN.measure);
    if (!measures.some((measure) => measure.id === topMeasure.id))
      throw new QueryCompileError("Select the Top N measure in the query.");
    order.push(`[r].${quote(measureAliases.get(topMeasure.id)!)} DESC`);
  }
  for (const entry of query.orderBy)
    order.push(
      `[r].${quote(resolveOrder(entry.ref))} ${entry.dir === "desc" ? "DESC" : "ASC"}`,
    );
  if (!order.length)
    for (const group of groups)
      order.push(`[r].${quote(groupAliases.get(group.column.id)!)} ASC`);
  const limit = query.topN ? Math.min(query.limit, query.topN.n) : query.limit;
  builder.params.push({ name: "__df_limit", value: limit + 1, type: "number" });
  if (builder.params.length > 2_000)
    throw new QueryCompileError(
      "The query uses too many parameter values. Reduce the number of filters or selected measures.",
    );
  const sql = `WITH ${ctes.join(",\n")}\nSELECT TOP (@__df_limit) ${[...columns.map((column) => `[r].${quote(column.key)}`), ...(pivotColumns.length ? ["[r].[__df_pivot_total]"] : [])].join(", ")}\nFROM ${quote(resultName)} AS [r]${pivotColumns.length ? "\nWHERE [r].[__df_pivot_rank] <= 50" : ""}${order.length ? `\nORDER BY ${order.join(", ")}` : ""};`;
  if (sql.length > 1_048_576)
    throw new QueryCompileError(
      "The compiled query is too complex (maximum 1 MiB of SQL). Choose fewer or simpler measures.",
    );
  return {
    sql,
    params: builder.params,
    columns,
    limit,
    ...(pivotColumns.length
      ? {
          pivot: {
            rowKeys: rows.map((ref) => groupAliases.get(ref.column.id)!),
            columnKeys: pivotColumns.map((ref) =>
              groupAliases.get(ref.column.id)!,
            ),
            measureKeys: measures.map((measure) =>
              measureAliases.get(measure.id)!,
            ),
          },
        }
      : {}),
  };
}

export function compileQuery(
  model: SemanticModel,
  input: unknown,
): CompiledQuery {
  try {
    return compileCheckedQuery(model, input);
  } catch (error) {
    if (error instanceof Error && error.name === "ExpressionError")
      throw new QueryCompileError(error.message);
    throw error;
  }
}

export function compileDistinctValues(
  model: SemanticModel,
  attribute: AttributeRef,
  hideUnknown = true,
): CompiledQuery {
  const resolved = resolveAttribute(model, attribute);
  const builder = new SqlBuilder(model, hideUnknown);
  builder.addColumn(resolved);
  builder.prepare();
  const { from, unknown } = builder.from();
  const column = builder.column(resolved);
  return {
    sql: `SELECT TOP (@__df_limit) ${column} AS [value], COUNT_BIG(*) AS [count]\nFROM ${from}${unknown.length ? `\nWHERE ${unknown.join(" AND ")}` : ""}\nGROUP BY ${column}\nORDER BY [count] DESC, [value] ASC;`,
    params: [{ name: "__df_limit", value: 1_001, type: "number" }],
    columns: [
      {
        key: "value",
        name: resolved.column.name,
        type: resolved.column.type,
        role: "attribute",
      },
      { key: "count", name: "Count", type: "number", role: "measure" },
    ],
    limit: 1_000,
  };
}
