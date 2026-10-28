import type { ResolvedExpr } from "../expr";
import type { SemanticColumn, SemanticModel, SemanticTable } from "../types";
import type { QueryFilter } from "./types";

type Ref = { table: SemanticTable; column: SemanticColumn };
type Filter = QueryFilter & { resolved: Ref };
type TimeTransform = { name: string; period?: "MONTH" | "QUARTER" | "YEAR" };
interface Context {
  filters: ResolvedExpr[];
  ignored: Set<string>;
  time?: { anchor: Context; transforms: TimeTransform[] };
}
export interface MaterializedBuilder {
  model: SemanticModel;
  usedColumns: Map<string, Ref>;
  column(ref: Ref, flatAlias?: string): string;
  flatName(id: string): string;
  param(value: string | number | boolean | null): string;
  filter(filter: Filter, alias?: string): string;
  baseProjection(): string;
}
interface Leaf {
  alias: string;
  name: string;
  argument: ResolvedExpr;
  context: Context;
  grain: number[];
  sumAlias?: string;
  countAlias?: string;
}
interface Anchor {
  alias: string;
  context: Context;
  grain: number[];
}
interface Window {
  alias: string;
  leaf: Leaf;
  kept: number[];
}
interface TimeScope {
  alias: string;
  context: Context;
  anchor: Anchor;
  leaves: Leaf[];
  kept: number[];
}

const quote = (value: string) => `[${value.replaceAll("]", "]]")}]`;
const aggregates = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "COUNT_BIG",
  "DISTINCTCOUNT",
]);
const times = new Set([
  "YTD",
  "MTD",
  "QTD",
  "SAMEPERIODLASTYEAR",
  "PREVIOUSPERIOD",
]);
const initial = (): Context => ({ filters: [], ignored: new Set() });
function key(node: ResolvedExpr): unknown {
  switch (node.kind) {
    case "literal":
      return ["literal", node.value];
    case "column":
      return ["column", node.column.id];
    case "measure":
      return ["measure", node.measure.id];
    case "unary":
      return [node.op, key(node.operand)];
    case "binary":
      return [node.op, key(node.left), key(node.right)];
    case "in":
      return ["in", node.negated, key(node.expression), node.values.map(key)];
    case "call":
      return [node.name, node.args.map(key)];
    case "period":
      return ["period", node.value];
    case "star":
      return ["star"];
  }
}
function contextKey(context: Context): string {
  return JSON.stringify([
    context.filters.map(key),
    [...context.ignored].sort(),
    context.time
      ? [contextKey(context.time.anchor), context.time.transforms]
      : null,
  ]);
}
function columns(node: ResolvedExpr): Set<string> {
  if (node.kind === "column") return new Set([node.column.id]);
  const children =
    node.kind === "binary"
      ? [node.left, node.right]
      : node.kind === "in"
        ? [node.expression, ...node.values]
        : node.kind === "unary"
          ? [node.operand]
          : node.kind === "call"
            ? node.args
            : [];
  return new Set(children.flatMap((child) => [...columns(child)]));
}
function calculate(context: Context, filters: ResolvedExpr[]): Context {
  const next = {
    ...context,
    filters: [...context.filters],
    ignored: new Set(context.ignored),
  };
  for (const filter of filters) {
    const ids = columns(filter);
    next.filters = next.filters.filter(
      (previous) => ![...columns(previous)].some((id) => ids.has(id)),
    );
    for (const id of ids) next.ignored.add(id);
    if (!(filter.kind === "call" && filter.name === "ALL"))
      next.filters.push(filter);
  }
  return next;
}

/** The only relation containing warehouse rows is the physical #df_base table. */
export class MaterializedPlan {
  readonly leaves: Leaf[] = [];
  private readonly leafKeys = new Map<string, Leaf>();
  private readonly anchors: Anchor[] = [];
  private readonly anchorKeys = new Map<string, Anchor>();
  private readonly windows: Window[] = [];
  private readonly windowKeys = new Map<string, Window>();
  private readonly scopes: TimeScope[] = [];
  private readonly scopeKeys = new Map<string, TimeScope>();
  private readonly scalarNodes: { alias: string; sql: string }[] = [];
  private readonly scalarKeys = new Map<string, string>();
  private readonly joins = new Map<string, string>();
  private readonly grains = new Map<string, number[]>();
  private readonly dateRef?: Ref;
  readonly fullGrain: number[];
  readonly dateIndex: number;

  constructor(
    readonly builder: MaterializedBuilder,
    readonly groups: Ref[],
    readonly filters: Filter[],
    readonly error: (message: string) => Error,
    usesTime: boolean,
  ) {
    this.fullGrain = groups.map((_, index) => index);
    this.dateIndex = groups.length;
    const date = builder.model.date;
    const table = date
      ? builder.model.tables.find((table) => table.id === date.tableId)
      : undefined;
    const column = table?.columns.find(
      (column) => column.id === date?.dateColumnId,
    );
    if (usesTime && table && column && builder.usedColumns.has(column.id))
      this.dateRef = { table, column };
    this.addGrain(this.fullGrain);
  }

  private addGrain(grain: number[]): void {
    this.grains.set(grain.join(","), [...grain]);
  }
  private kept(context: Context, clearDate = false): number[] {
    return this.groups.flatMap((group, index) =>
      context.ignored.has(group.column.id) ||
      (clearDate && group.table.id === this.builder.model.date?.tableId)
        ? []
        : [index],
    );
  }
  private groupColumn(index: number, alias: string): string {
    return `${quote(alias)}.${index === this.dateIndex ? "[__df_date]" : quote(`__df_k${index}`)}`;
  }
  private grainMask(grain: number[]): number {
    const total = this.groups.length + (this.dateRef ? 1 : 0);
    return Array.from({ length: total }, (_, index) =>
      grain.includes(index) ? 0 : 2 ** (total - index - 1),
    ).reduce((sum, bit) => sum + bit, 0);
  }
  private predicates(context: Context, alias = "b"): string[] {
    return [
      ...this.filters
        .filter(
          (filter) =>
            !context.ignored.has(filter.resolved.column.id) &&
            !(
              context.time &&
              filter.resolved.table.id === this.builder.model.date?.tableId
            ),
        )
        .map((filter) => this.builder.filter(filter, alias)),
      ...context.filters.map((filter) => this.rowPredicate(filter, alias)),
    ];
  }
  private conditional(value: string, context: Context, alias = "b"): string {
    const predicates = this.predicates(context, alias);
    return predicates.length
      ? `CASE WHEN ${predicates.join(" AND ")} THEN ${value} END`
      : value;
  }

  private rowValue(node: ResolvedExpr, alias: string): string {
    if (node.kind === "column") return this.builder.column(node, alias);
    if (node.kind === "literal")
      return node.value === null ? "NULL" : this.builder.param(node.value);
    if (node.kind === "unary" && node.op !== "NOT")
      return `(${node.op}${this.rowValue(node.operand, alias)})`;
    throw this.error("A row filter must compare a column to literal values.");
  }
  private rowPredicate(node: ResolvedExpr, alias: string): string {
    if (node.kind === "binary") {
      if (node.op === "AND" || node.op === "OR")
        return `(${this.rowPredicate(node.left, alias)} ${node.op} ${this.rowPredicate(node.right, alias)})`;
      const left = this.rowValue(node.left, alias);
      if (
        node.right.kind === "literal" &&
        node.right.value === null &&
        ["=", "!=", "<>"].includes(node.op)
      )
        return `(${left} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
      return `(${left} ${node.op === "!=" ? "<>" : node.op} ${this.rowValue(node.right, alias)})`;
    }
    if (node.kind === "in") {
      const value = this.rowValue(node.expression, alias);
      const nonNull = node.values.filter(
        (item) => !(item.kind === "literal" && item.value === null),
      );
      const hasNull = nonNull.length !== node.values.length;
      const parts = [
        nonNull.length
          ? `${value} ${node.negated ? "NOT " : ""}IN (${nonNull.map((item) => this.rowValue(item, alias)).join(", ")})`
          : "",
        hasNull ? `${value} IS ${node.negated ? "NOT " : ""}NULL` : "",
      ].filter(Boolean);
      return `(${parts.join(node.negated ? " AND " : " OR ") || (node.negated ? "1 = 1" : "1 = 0")})`;
    }
    throw this.error("Invalid calculated filter.");
  }

  private time(
    context: Context,
    node: ResolvedExpr & { kind: "call" },
  ): Context {
    if (!this.dateRef)
      throw this.error(
        "Time intelligence requires a generated date relationship.",
      );
    const dateColumns = new Set(
      this.builder.model.tables
        .find((table) => table.id === this.builder.model.date?.tableId)!
        .columns.map((column) => column.id),
    );
    const transform: TimeTransform = {
      name: node.name,
      ...(node.args[1]?.kind === "period"
        ? { period: node.args[1].value }
        : {}),
    };
    return {
      ...context,
      filters: context.filters.filter(
        (filter) => ![...columns(filter)].some((id) => dateColumns.has(id)),
      ),
      time: {
        anchor: context.time?.anchor ?? context,
        transforms: [...(context.time?.transforms ?? []), transform],
      },
    };
  }
  private anchor(context: Context): Anchor {
    const id = contextKey(context);
    let anchor = this.anchorKeys.get(id);
    if (!anchor) {
      anchor = {
        alias: `__df_anchor${this.anchors.length}`,
        context,
        grain: this.kept(context),
      };
      this.anchors.push(anchor);
      this.anchorKeys.set(id, anchor);
      this.addGrain(anchor.grain);
    }
    return anchor;
  }

  private aggregate(
    name: string,
    argument: ResolvedExpr,
    context: Context,
  ): string {
    name = name === "COUNT" ? "COUNT_BIG" : name;
    const kept = this.kept(context, !!context.time);
    const removesGrouping = kept.length !== this.groups.length;
    const additiveWindow =
      !context.time &&
      removesGrouping &&
      ["SUM", "COUNT_BIG", "MIN", "MAX"].includes(name);
    const grain = context.time
      ? [...kept, this.dateIndex]
      : additiveWindow
        ? this.fullGrain
        : kept;
    const predicatesKey = JSON.stringify([
      this.filters
        .filter(
          (filter) =>
            !context.ignored.has(filter.resolved.column.id) &&
            !(
              context.time &&
              filter.resolved.table.id === this.builder.model.date?.tableId
            ),
        )
        .map((filter) => [
          filter.resolved.column.id,
          filter.op,
          filter.value,
          filter.values,
        ]),
      context.filters.map(key),
    ]);
    const id = JSON.stringify([name, key(argument), predicatesKey, grain]);
    let leaf = this.leafKeys.get(id);
    if (!leaf) {
      leaf = {
        alias: `__df_v${this.leaves.length}`,
        name,
        argument,
        context,
        grain,
      };
      if (name === "AVG") {
        leaf.sumAlias = `${leaf.alias}_sum`;
        leaf.countAlias = `${leaf.alias}_count`;
      }
      this.leaves.push(leaf);
      this.leafKeys.set(id, leaf);
      this.addGrain(grain);
    }
    if (context.time) {
      // DISTINCTCOUNT is not additive across days; its exact set is joined from
      // the already-materialized base instead of summing daily distinct counts.
      const timeId = `${contextKey(context)}:${name === "DISTINCTCOUNT" ? "distinct" : "daily"}`;
      let scope = this.scopeKeys.get(timeId);
      if (!scope) {
        scope = {
          alias: `#df_scope_${this.scopes.length}`,
          context,
          anchor: this.anchor(context.time.anchor),
          leaves: [],
          kept,
        };
        this.scopes.push(scope);
        this.scopeKeys.set(timeId, scope);
      }
      if (!scope.leaves.includes(leaf)) scope.leaves.push(leaf);
      this.joins.set(
        scope.alias,
        `LEFT JOIN ${quote(scope.alias)} AS ${quote(`t${this.scopes.indexOf(scope)}`)} ON ${quote(`t${this.scopes.indexOf(scope)}`)}.[__df_gid] = [g].[__df_gid]`,
      );
      return `${quote(`t${this.scopes.indexOf(scope)}`)}.${quote(leaf.alias)}`;
    }
    if (additiveWindow) {
      const windowId = JSON.stringify([leaf.alias, kept]);
      let window = this.windowKeys.get(windowId);
      if (!window) {
        window = { alias: `__df_w${this.windows.length}`, leaf, kept };
        this.windows.push(window);
        this.windowKeys.set(windowId, window);
      }
      return `[g].${quote(window.alias)}`;
    }
    if (grain.length === this.fullGrain.length)
      return `[g].${quote(leaf.alias)}`;
    const alias = `s${this.grainMask(grain)}`;
    this.joins.set(
      alias,
      `LEFT JOIN [#df_agg] AS ${quote(alias)} ON ${quote(alias)}.[__df_grain] = ${this.grainMask(grain)}${grain.map((index) => ` AND ${this.groupColumn(index, alias)} = ${this.groupColumn(index, "g")}`).join("")}`,
    );
    return `${quote(alias)}.${quote(leaf.alias)}`;
  }

  scalar(id: string, node: ResolvedExpr, context: Context = initial()): string {
    const cacheKey = JSON.stringify([id, contextKey(context)]);
    const existing = this.scalarKeys.get(cacheKey);
    if (existing) return existing;
    const sql = this.render(node, context);
    const alias = `__df_d${this.scalarNodes.length}`;
    this.scalarNodes.push({ alias, sql });
    const reference = `${quote(alias)}.[v]`;
    this.scalarKeys.set(cacheKey, reference);
    return reference;
  }
  private predicate(node: ResolvedExpr, context: Context): string {
    if (node.kind === "unary" && node.op === "NOT")
      return `(NOT ${this.predicate(node.operand, context)})`;
    if (node.kind === "binary" && (node.op === "AND" || node.op === "OR"))
      return `(${this.predicate(node.left, context)} ${node.op} ${this.predicate(node.right, context)})`;
    if (
      node.kind === "binary" &&
      ["=", "!=", "<>", "<", "<=", ">", ">="].includes(node.op)
    ) {
      const left = this.render(node.left, context),
        right = this.render(node.right, context);
      if (
        ((node.left.kind === "literal" && node.left.value === null) ||
          (node.right.kind === "literal" && node.right.value === null)) &&
        ["=", "!=", "<>"].includes(node.op)
      )
        return `(${node.left.kind === "literal" && node.left.value === null ? right : left} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
      return `(${left} ${node.op === "!=" ? "<>" : node.op} ${right})`;
    }
    if (node.kind === "in") {
      const left = this.render(node.expression, context);
      const values = node.values.filter(
        (value) => !(value.kind === "literal" && value.value === null),
      );
      const nullValue = values.length !== node.values.length;
      const parts = [
        values.length
          ? `${left} ${node.negated ? "NOT " : ""}IN (${values.map((value) => this.render(value, context)).join(", ")})`
          : "",
        nullValue ? `${left} IS ${node.negated ? "NOT " : ""}NULL` : "",
      ].filter(Boolean);
      return `(${parts.join(node.negated ? " AND " : " OR ")})`;
    }
    return `(${this.render(node, context)} = CAST(1 AS BIT))`;
  }
  private render(node: ResolvedExpr, context: Context): string {
    let sql: string;
    if (node.kind === "literal")
      sql = node.value === null ? "NULL" : this.builder.param(node.value);
    else if (node.kind === "measure")
      sql = this.scalar(node.measure.id, node.expression, context);
    else if (node.kind === "unary")
      sql =
        node.op === "NOT"
          ? `(CASE WHEN ${this.predicate(node, context)} THEN CAST(1 AS BIT) WHEN NOT ${this.predicate(node, context)} THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`
          : `(${node.op}${this.render(node.operand, context)})`;
    else if (
      node.kind === "in" ||
      (node.kind === "binary" && !["+", "-", "*", "/", "%"].includes(node.op))
    ) {
      const predicate = this.predicate(node, context);
      sql = `(CASE WHEN ${predicate} THEN CAST(1 AS BIT) WHEN NOT ${predicate} THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`;
    } else if (node.kind === "binary") {
      const left = this.render(node.left, context),
        right = this.render(node.right, context);
      sql =
        node.op === "/"
          ? `(CAST(${left} AS FLOAT) / NULLIF(${right}, 0))`
          : node.op === "%"
            ? `(${left} % NULLIF(${right}, 0))`
            : `(${left} ${node.op} ${right})`;
    } else if (node.kind === "call") {
      if (aggregates.has(node.name))
        sql = this.aggregate(node.name, node.args[0], context);
      else if (node.name === "CALCULATE")
        sql = this.render(node.args[0], calculate(context, node.args.slice(1)));
      else if (times.has(node.name))
        sql = this.render(node.args[0], this.time(context, node));
      else if (node.name === "DIVIDE") {
        const numerator = this.render(node.args[0], context),
          denominator = this.render(node.args[1], context);
        const divided = `(CAST(${numerator} AS FLOAT) / NULLIF(${denominator}, 0))`;
        // The default NULL alternate needs no CASE: NULLIF already implements
        // both zero/NULL denominator cases. A single denominator reference also
        // prevents the optimizer expanding nested ratio expressions threefold.
        sql =
          !node.args[2] ||
          (node.args[2].kind === "literal" && node.args[2].value === null)
            ? divided
            : `(CASE WHEN NULLIF(${denominator}, 0) IS NULL THEN ${this.render(node.args[2], context)} ELSE ${divided} END)`;
      } else if (node.name === "IF")
        sql = `(CASE WHEN ${this.predicate(node.args[0], context)} THEN ${this.render(node.args[1], context)} ELSE ${this.render(node.args[2], context)} END)`;
      else if (node.name === "ABS" || node.name === "ROUND")
        sql = `${node.name}(${node.args.map((argument) => this.render(argument, context)).join(", ")})`;
      else throw this.error("Unsupported scalar function.");
    } else throw this.error("A scalar measure must aggregate its columns.");
    if (sql.length > 262_144)
      throw this.error(
        "The compiled measure is too complex (maximum 256 KiB of SQL).",
      );
    return sql;
  }

  private aggregateSql(leaf: Leaf): string[] {
    const source =
      leaf.argument.kind === "column"
        ? this.builder.column(leaf.argument, "b")
        : "1";
    const value = this.conditional(source, leaf.context);
    if (leaf.name === "AVG")
      return [
        `SUM(CAST(${value} AS FLOAT)) AS ${quote(leaf.sumAlias!)}`,
        `COUNT_BIG(${value}) AS ${quote(leaf.countAlias!)}`,
        `AVG(CAST(${value} AS FLOAT)) AS ${quote(leaf.alias)}`,
      ];
    const expression =
      leaf.name === "DISTINCTCOUNT"
        ? `COUNT_BIG(DISTINCT ${value})`
        : leaf.name === "COUNT_BIG"
          ? `COUNT_BIG(${value})`
          : `${leaf.name}(${leaf.name === "SUM" ? `CAST(${value} AS DECIMAL(38, 10))` : value})`;
    return [`${expression} AS ${quote(leaf.alias)}`];
  }
  private joinKeys(grain: number[], left: string, right: string): string {
    return (
      grain
        .map(
          (index) =>
            `${this.groupColumn(index, left)} = ${this.groupColumn(index, right)}`,
        )
        .join(" AND ") || "1 = 1"
    );
  }
  private bounds(scope: TimeScope): { start: string; end: string } {
    let start = `[a].${quote(`${scope.anchor.alias}_start`)}`;
    let end = `[a].${quote(`${scope.anchor.alias}_end`)}`;
    for (const transform of scope.context.time!.transforms) {
      const year = `DATEFROMPARTS(YEAR(${end}), 1, 1)`;
      const month = `DATEFROMPARTS(YEAR(${end}), MONTH(${end}), 1)`;
      const quarter = `DATEFROMPARTS(YEAR(${end}), (DATEPART(QUARTER, ${end}) - 1) * 3 + 1, 1)`;
      if (transform.name === "YTD") start = year;
      else if (transform.name === "MTD") start = month;
      else if (transform.name === "QTD") start = quarter;
      else if (transform.name === "SAMEPERIODLASTYEAR") {
        start = `DATEADD(YEAR, -1, ${start})`;
        end = `DATEADD(YEAR, -1, ${end})`;
      } else {
        const period = transform.period ?? "MONTH";
        const beginning =
          period === "YEAR" ? year : period === "QUARTER" ? quarter : month;
        start = `DATEADD(${period}, -1, ${beginning})`;
        end = `DATEADD(DAY, -1, ${beginning})`;
      }
    }
    return { start, end };
  }

  statements(
    from: string,
    unknown: string[],
  ): {
    statements: string[];
    source: string;
    joins: string[];
    applies: string[];
    tempTables: string[];
  } {
    const statements: string[] = [];
    const tempTables = ["#df_base", "#df_agg", "#df_groups"];
    const groupProjections = this.groups.map(
      (group, index) =>
        `DENSE_RANK() OVER (ORDER BY ${this.builder.column(group)}) AS ${quote(`__df_k${index}`)}`,
    );
    if (!groupProjections.length)
      groupProjections.push("CAST(0 AS INT) AS [__df_k0]");
    if (this.dateRef)
      groupProjections.push(
        `${this.builder.column(this.dateRef)} AS [__df_date]`,
      );
    statements.push(
      `SELECT ${this.builder.baseProjection()},\n  ${groupProjections.join(",\n  ")}\nINTO [#df_base]\nFROM ${from}${unknown.length ? `\nWHERE ${unknown.join(" AND ")}` : ""};`,
    );
    statements.push(
      `CREATE CLUSTERED INDEX [ix_df_base_groups] ON [#df_base] (${this.groups.length ? this.groups.map((_, index) => quote(`__df_k${index}`)).join(", ") : "[__df_k0]"});`,
    );
    const groupingColumns = [
      ...this.fullGrain,
      ...(this.dateRef ? [this.dateIndex] : []),
    ];
    const keyProjection = groupingColumns.map((index) =>
      this.groupColumn(index, "b"),
    );
    const attributes = this.groups.map(
      (group, index) =>
        `${group.column.type === "boolean" ? `CAST(MAX(CAST(${this.builder.column(group, "b")} AS TINYINT)) AS BIT)` : `MAX(${this.builder.column(group, "b")})`} AS ${quote(`a${index}`)}`,
    );
    const anchorProjections = this.anchors.flatMap((anchor) => {
      const date = this.conditional("[b].[__df_date]", anchor.context);
      return [
        `MIN(${date}) AS ${quote(`${anchor.alias}_start`)}`,
        `MAX(${date}) AS ${quote(`${anchor.alias}_end`)}`,
      ];
    });
    const projections = [
      groupingColumns.length
        ? `GROUPING_ID(${keyProjection.join(", ")}) AS [__df_grain]`
        : "CAST(0 AS INT) AS [__df_grain]",
      ...keyProjection,
      ...attributes,
      ...this.leaves.flatMap((leaf) => this.aggregateSql(leaf)),
      ...anchorProjections,
      `COUNT_BIG(${this.conditional("1", initial())}) AS [__df_group_count]`,
    ];
    statements.push(
      `SELECT ${projections.join(",\n  ")}\nINTO [#df_agg]\nFROM [#df_base] AS [b]\nGROUP BY GROUPING SETS (${[...this.grains.values()].map((grain) => `(${grain.map((index) => this.groupColumn(index, "b")).join(", ")})`).join(", ")});`,
    );
    statements.push(
      `CREATE CLUSTERED INDEX [ix_df_agg_grain] ON [#df_agg] ([__df_grain]${this.dateRef ? ", [__df_date]" : ""}${this.fullGrain.map((index) => `, ${quote(`__df_k${index}`)}`).join("")});`,
    );
    statements.push(
      `SELECT ROW_NUMBER() OVER (ORDER BY ${this.fullGrain.length ? this.fullGrain.map((index) => this.groupColumn(index, "a")).join(", ") : "[a].[__df_grain]"}) AS [__df_gid], [a].*\nINTO [#df_groups]\nFROM [#df_agg] AS [a]\nWHERE [a].[__df_grain] = ${this.grainMask(this.fullGrain)};`,
    );
    statements.push(
      "CREATE UNIQUE CLUSTERED INDEX [ix_df_groups_id] ON [#df_groups] ([__df_gid]);",
    );
    for (const scope of this.scopes) {
      const bounds = this.bounds(scope);
      const distinct = scope.leaves.every(
        (leaf) => leaf.name === "DISTINCTCOUNT",
      );
      const projections = scope.leaves.map((leaf) =>
        leaf.name === "AVG"
          ? `SUM([d].${quote(leaf.sumAlias!)}) / NULLIF(SUM([d].${quote(leaf.countAlias!)}), 0) AS ${quote(leaf.alias)}`
          : `${leaf.name === "COUNT_BIG" ? "COALESCE(SUM" : leaf.name === "SUM" ? "SUM" : leaf.name === "MIN" ? "MIN" : leaf.name === "MAX" ? "MAX" : "COUNT_BIG"}([d].${quote(leaf.alias)})${leaf.name === "COUNT_BIG" ? ", 0)" : ""} AS ${quote(leaf.alias)}`,
      );
      const source = distinct ? "[#df_base]" : "[#df_agg]";
      const values = distinct
        ? scope.leaves.map(
            (leaf) =>
              `COUNT_BIG(DISTINCT ${this.conditional(leaf.argument.kind === "column" ? this.builder.column(leaf.argument, "d") : "NULL", scope.context, "d")}) AS ${quote(leaf.alias)}`,
          )
        : projections;
      statements.push(
        `SELECT [g].[__df_gid], ${values.join(", ")}\nINTO ${quote(scope.alias)}\nFROM [#df_groups] AS [g]\nLEFT JOIN [#df_agg] AS [a] ON [a].[__df_grain] = ${this.grainMask(scope.anchor.grain)} AND ${this.joinKeys(scope.anchor.grain, "a", "g")}\nLEFT JOIN ${source} AS [d] ON ${distinct ? "" : `[d].[__df_grain] = ${this.grainMask([...scope.kept, this.dateIndex])} AND `}${this.joinKeys(scope.kept, "d", "g")} AND [d].[__df_date] >= ${bounds.start} AND [d].[__df_date] <= ${bounds.end}\nGROUP BY [g].[__df_gid];`,
      );
      statements.push(
        `CREATE UNIQUE CLUSTERED INDEX ${quote(`ix_df_scope_${this.scopes.indexOf(scope)}`)} ON ${quote(scope.alias)} ([__df_gid]);`,
      );
      tempTables.push(scope.alias);
    }
    let source = "#df_groups";
    if (this.windows.length) {
      statements.push(
        `SELECT [g].*, ${this.windows.map((window) => `${window.leaf.name === "MIN" || window.leaf.name === "MAX" ? window.leaf.name : "SUM"}([g].${quote(window.leaf.alias)}) OVER (${window.kept.length ? `PARTITION BY ${window.kept.map((index) => this.groupColumn(index, "g")).join(", ")}` : ""}) AS ${quote(window.alias)}`).join(", ")}\nINTO [#df_totals]\nFROM [#df_groups] AS [g];`,
      );
      source = "#df_totals";
      tempTables.push(source);
    }
    return {
      statements,
      source,
      joins: [...this.joins.values()],
      applies: this.scalarNodes.map(
        (node) =>
          `CROSS APPLY (VALUES (${node.sql})) AS ${quote(node.alias)} ([v])`,
      ),
      tempTables,
    };
  }
}

export function materializedBatch(
  statements: string[],
  finalSelect: string,
  tempTables: string[],
): string {
  const cleanup = [...tempTables]
    .reverse()
    .map((name) => `DROP TABLE IF EXISTS ${quote(name)};`)
    .join("\n");
  return `SET NOCOUNT ON;\n${cleanup}\nBEGIN TRY\n${statements.join("\n")}\n${finalSelect}\n${cleanup}\nEND TRY\nBEGIN CATCH\n${cleanup}\nTHROW;\nEND CATCH;`;
}
