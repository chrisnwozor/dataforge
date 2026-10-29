/** Independent SQL oracle. Syntax is shared; resolution, context rules, relational
 * construction and arithmetic are deliberately separate from the semantic compiler. */
import { parse } from "@/lib/semantic/expr/parser";
import type { Expr } from "@/lib/semantic/expr/types";
import type {
  AttributeRef,
  QueryFilter,
  SemanticQuery,
} from "@/lib/semantic/query/types";
import type {
  SemanticColumn,
  SemanticMeasure,
  SemanticModel,
  SemanticTable,
  SemanticType,
  SqlParameter,
} from "@/lib/semantic/types";
import type { ReferenceSql } from "./types";

export class UnsupportedReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedReferenceError";
  }
}
const quote = (name: string) => {
  if (
    !name ||
    name.length > 128 ||
    /[\u0000-\u001f\u007f\u2028\u2029]/.test(name)
  )
    throw new UnsupportedReferenceError(
      "The saved model contains an invalid SQL identifier.",
    );
  return `[${name.replaceAll("]", "]]")}]`;
};
const fold = (value: string) => value.toLowerCase();
const refKey = (ref: AttributeRef) => JSON.stringify([ref.table, ref.column]);
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
interface ResolvedColumn {
  table: SemanticTable;
  column: SemanticColumn;
  ref: AttributeRef;
}
interface TimeTransform {
  name: string;
  period?: string;
}
interface Context {
  removed: Set<string>;
  filters: QueryFilter[];
  times: TimeTransform[];
}
interface Leaf {
  id: number;
  aggregate: string;
  column: ResolvedColumn | null;
  context: Context;
}

function unique<T>(items: T[], label: string): T {
  if (items.length !== 1)
    throw new UnsupportedReferenceError(
      items.length
        ? `The ${label} is ambiguous in the saved metadata.`
        : `The ${label} is missing from the saved metadata.`,
    );
  return items[0];
}
export function referenceMeasure(
  model: SemanticModel,
  name: string,
): SemanticMeasure {
  return unique(
    model.measures.filter((m) =>
      [m.id, m.name].some((v) => fold(v) === fold(name)),
    ),
    `measure ${name}`,
  );
}
function resolveColumn(
  model: SemanticModel,
  tableName: string,
  columnName: string,
): ResolvedColumn {
  const table = unique(
    model.tables.filter((t) =>
      [t.id, t.name, t.sqlName].some((v) => fold(v) === fold(tableName)),
    ),
    `table ${tableName}`,
  );
  const column = unique(
    table.columns.filter((c) =>
      [c.id, c.name, c.sqlName].some((v) => fold(v) === fold(columnName)),
    ),
    `column ${tableName}[${columnName}]`,
  );
  return { table, column, ref: { table: table.id, column: column.id } };
}
function astFor(
  model: SemanticModel,
  name: string,
  path = new Set<string>(),
): Expr {
  const measure = referenceMeasure(model, name);
  if (path.has(measure.id))
    throw new UnsupportedReferenceError(
      `Measure reference cycle at ${measure.name}.`,
    );
  try {
    return parse(measure.expression);
  } catch (error) {
    throw new UnsupportedReferenceError(
      `Cannot independently parse ${measure.name}: ${error instanceof Error ? error.message : "invalid syntax"}`,
    );
  }
}
function inspect(
  model: SemanticModel,
  name: string,
): {
  additive: boolean;
  ratio: boolean;
  percentOfTotal: boolean;
  time: boolean;
} {
  const path = new Set<string>();
  let visited = 0;
  const walk = (
    node: Expr,
  ): {
    additive: boolean;
    ratio: boolean;
    percentOfTotal: boolean;
    time: boolean;
  } => {
    if (++visited > 2048)
      throw new UnsupportedReferenceError(
        "Measure expansion exceeds the independent reference budget.",
      );
    if (node.kind === "measure") {
      const measure = referenceMeasure(model, node.name);
      if (path.has(measure.id))
        throw new UnsupportedReferenceError("Measure reference cycle.");
      path.add(measure.id);
      try {
        return walk(astFor(model, measure.id));
      } finally {
        path.delete(measure.id);
      }
    }
    if (node.kind === "call") {
      const children = node.args.map(walk);
      return {
        additive: ["SUM", "COUNT", "COUNT_BIG"].includes(node.name),
        ratio: node.name === "DIVIDE" || children.some((c) => c.ratio),
        percentOfTotal:
          (node.name === "CALCULATE" &&
            node.args.some((a) => a.kind === "call" && a.name === "ALL")) ||
          children.some((c) => c.percentOfTotal),
        time: times.has(node.name) || children.some((c) => c.time),
      };
    }
    const children =
      node.kind === "binary"
        ? [walk(node.left), walk(node.right)]
        : node.kind === "unary"
          ? [walk(node.operand)]
          : node.kind === "in"
            ? [walk(node.expression), ...node.values.map(walk)]
            : [];
    return {
      additive: false,
      ratio:
        (node.kind === "binary" && node.op === "/") ||
        children.some((c) => c.ratio),
      percentOfTotal: children.some((c) => c.percentOfTotal),
      time: children.some((c) => c.time),
    };
  };
  return walk(astFor(model, name));
}
export const classifyMeasure = (model: SemanticModel, name: string) =>
  inspect(model, name);
export function isAdditiveMeasure(model: SemanticModel, name: string): boolean {
  try {
    return inspect(model, name).additive;
  } catch {
    return false;
  }
}

class ReferenceBuilder {
  readonly params: SqlParameter[] = [];
  readonly leaves: Leaf[] = [];
  readonly groups: ResolvedColumn[];
  readonly fact: SemanticTable;
  private aliases = new Map<string, string>();
  private expansions = new Set<string>();
  private visits = 0;
  constructor(
    readonly model: SemanticModel,
    readonly query: SemanticQuery,
  ) {
    this.fact = unique(
      model.tables.filter(
        (t) => t.id === model.factTableId && t.kind === "fact",
      ),
      "fact table",
    );
    this.aliases.set(this.fact.id, "f");
    model.tables
      .filter((t) => t.id !== this.fact.id)
      .forEach((t, i) => this.aliases.set(t.id, `d${i}`));
    this.groups = [...query.rows, ...(query.columns ?? [])].map((r) =>
      resolveColumn(model, r.table, r.column),
    );
    if (
      new Set(this.groups.map((g) => refKey(g.ref))).size !== this.groups.length
    )
      throw new UnsupportedReferenceError(
        "Duplicate grouping attributes are not supported by the independent reference.",
      );
    if (
      this.groups.length > 12 ||
      query.measures.length > 64 ||
      query.filters.length > 64
    )
      throw new UnsupportedReferenceError(
        "The independent reference supports up to 12 groups, 64 measures and 64 filters per query.",
      );
    if (query.topN)
      throw new UnsupportedReferenceError(
        "Top N and per-group Top N need a separate ranking oracle and are not independently verified yet.",
      );
  }
  parameter(
    value: string | number | boolean | null,
    type?: SqlParameter["type"],
  ): string {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new UnsupportedReferenceError("Non-finite reference parameter.");
    if (this.params.length >= 1800)
      throw new UnsupportedReferenceError(
        "Independent reference parameter budget exceeded.",
      );
    const name = `vr${this.params.length}`;
    this.params.push({ name, value, ...(type ? { type } : {}) });
    return `@${name}`;
  }
  physical(column: ResolvedColumn): string {
    return `${quote(this.aliases.get(column.table.id)!)}.${quote(column.column.sqlName)}`;
  }
  from(required: ReadonlySet<string>): { sql: string; unknown: string[] } {
    const joined = new Set([this.fact.id]);
    const joins: string[] = [],
      unknown: string[] = [];
    for (const tableId of required) {
      if (joined.has(tableId)) continue;
      const relationship = unique(
        this.model.relationships.filter(
          (r) => r.fromTableId === this.fact.id && r.toTableId === tableId,
        ),
        `relationship to ${tableId}`,
      );
      const target = unique(
        this.model.tables.filter((t) => t.id === tableId),
        `table ${tableId}`,
      );
      const source = unique(
        this.fact.columns.filter((c) => c.id === relationship.fromColumnId),
        "foreign key",
      );
      const destination = unique(
        target.columns.filter((c) => c.id === relationship.toColumnId),
        "dimension key",
      );
      joins.push(
        `LEFT JOIN ${quote(target.schema)}.${quote(target.sqlName)} AS ${quote(this.aliases.get(tableId)!)} ON ${quote("f")}.${quote(source.sqlName)} = ${quote(this.aliases.get(tableId)!)}.${quote(destination.sqlName)}`,
      );
      if (this.query.hideUnknown)
        unknown.push(`${quote("f")}.${quote(source.sqlName)} <> -1`);
      joined.add(tableId);
    }
    return {
      sql: `FROM ${quote(this.fact.schema)}.${quote(this.fact.sqlName)} AS [f]${joins.length ? "\n" + joins.join("\n") : ""}`,
      unknown,
    };
  }
  filter(filter: QueryFilter, required: Set<string>): string {
    const col = resolveColumn(
      this.model,
      filter.attribute.table,
      filter.attribute.column,
    );
    required.add(col.table.id);
    const value = this.physical(col),
      param = (v: string | number | boolean | null) =>
        this.parameter(v, col.column.type);
    if (filter.op === "isNull") return `${value} IS NULL`;
    if (filter.op === "isNotNull") return `${value} IS NOT NULL`;
    if (filter.op === "in" || filter.op === "notIn") {
      const entries = filter.values ?? [];
      if (entries.length > 500)
        throw new UnsupportedReferenceError(
          "Reference IN lists support at most 500 values.",
        );
      const nonNull = entries.filter((v) => v !== null),
        containsNull = entries.includes(null),
        negated = filter.op === "notIn";
      const parts = nonNull.length
        ? [
            `${value} ${negated ? "NOT IN" : "IN"} (${nonNull.map(param).join(", ")})`,
          ]
        : [];
      if (containsNull) parts.push(`${value} IS ${negated ? "NOT " : ""}NULL`);
      if (!parts.length) return negated ? "1 = 1" : "1 = 0";
      return `(${parts.join(negated ? " AND " : " OR ")})`;
    }
    if (filter.value === null)
      return `${value} IS ${filter.op === "ne" ? "NOT " : ""}NULL`;
    if (filter.value === undefined)
      throw new UnsupportedReferenceError(
        "A reference filter is missing its comparison value.",
      );
    const op = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[
      filter.op
    ];
    if (!op)
      throw new UnsupportedReferenceError(
        "Unsupported independent filter operator.",
      );
    return `${value} ${op} ${param(filter.value)}`;
  }
  contextFilter(node: Expr): QueryFilter {
    if (
      node.kind === "binary" &&
      ["=", "!=", "<>", "<", "<=", ">", ">="].includes(node.op) &&
      node.left.kind === "column" &&
      node.right.kind === "literal"
    ) {
      const c = resolveColumn(
          this.model,
          node.left.tableName,
          node.left.columnName,
        ),
        ops: Record<string, QueryFilter["op"]> = {
          "=": "eq",
          "!=": "ne",
          "<>": "ne",
          "<": "lt",
          "<=": "lte",
          ">": "gt",
          ">=": "gte",
        };
      return { attribute: c.ref, op: ops[node.op], value: node.right.value };
    }
    if (
      node.kind === "in" &&
      node.expression.kind === "column" &&
      node.values.every((v) => v.kind === "literal")
    ) {
      const c = resolveColumn(
        this.model,
        node.expression.tableName,
        node.expression.columnName,
      );
      return {
        attribute: c.ref,
        op: node.negated ? "notIn" : "in",
        values: node.values.map(
          (v) => (v as Extract<Expr, { kind: "literal" }>).value,
        ),
      };
    }
    throw new UnsupportedReferenceError(
      "CALCULATE references support direct column comparisons or literal IN lists; this filter needs a new independent oracle.",
    );
  }
  expression(node: Expr, context: Context): string {
    if (++this.visits > 4096)
      throw new UnsupportedReferenceError(
        "Measure expansion exceeds the independent reference budget.",
      );
    if (node.kind === "measure") {
      const m = referenceMeasure(this.model, node.name);
      if (this.expansions.has(m.id))
        throw new UnsupportedReferenceError(
          `Measure reference cycle at ${m.name}.`,
        );
      this.expansions.add(m.id);
      try {
        return this.expression(astFor(this.model, m.id), context);
      } finally {
        this.expansions.delete(m.id);
      }
    }
    if (node.kind === "literal") return this.parameter(node.value);
    if (node.kind === "unary")
      return node.op === "NOT"
        ? `(NOT ${this.predicate(node.operand, context)})`
        : `(${node.op}${this.expression(node.operand, context)})`;
    if (node.kind === "binary") {
      if (node.op === "AND" || node.op === "OR")
        return `(${this.predicate(node.left, context)} ${node.op} ${this.predicate(node.right, context)})`;
      if (
        ["=", "!=", "<>"].includes(node.op) &&
        ((node.left.kind === "literal" && node.left.value === null) ||
          (node.right.kind === "literal" && node.right.value === null))
      ) {
        const other =
          node.left.kind === "literal" && node.left.value === null
            ? node.right
            : node.left;
        return `(${this.expression(other, context)} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
      }
      const a = this.expression(node.left, context),
        b = this.expression(node.right, context);
      return node.op === "/"
        ? `(1.0 * ${a} / NULLIF(${b}, 0))`
        : `(${a} ${node.op === "!=" ? "<>" : node.op} ${b})`;
    }
    if (node.kind === "in")
      return `(${this.expression(node.expression, context)} ${node.negated ? "NOT " : ""}IN (${node.values.map((v) => this.expression(v, context)).join(", ")}))`;
    if (node.kind !== "call")
      throw new UnsupportedReferenceError(
        "The independent oracle only accepts aggregated columns inside a measure.",
      );
    if (aggregates.has(node.name)) {
      if (node.args.length !== 1)
        throw new UnsupportedReferenceError(
          `${node.name} must have one independent aggregate input.`,
        );
      const arg = node.args[0],
        column =
          arg.kind === "star" && ["COUNT", "COUNT_BIG"].includes(node.name)
            ? null
            : arg.kind === "column"
              ? resolveColumn(this.model, arg.tableName, arg.columnName)
              : undefined;
      if (column === undefined)
        throw new UnsupportedReferenceError(
          `${node.name} references require one physical column (or COUNT(*)).`,
        );
      const signature = JSON.stringify([
        node.name,
        column?.ref ?? null,
        [...context.removed].sort(),
        context.filters,
        context.times,
      ]);
      let leaf = this.leaves.find(
        (l) =>
          JSON.stringify([
            l.aggregate,
            l.column?.ref ?? null,
            [...l.context.removed].sort(),
            l.context.filters,
            l.context.times,
          ]) === signature,
      );
      if (!leaf) {
        if (this.leaves.length >= 128)
          throw new UnsupportedReferenceError(
            "The independent aggregate/context budget is 128 leaves.",
          );
        leaf = {
          id: this.leaves.length,
          aggregate: node.name,
          column: column ?? null,
          context: {
            removed: new Set(context.removed),
            filters: [...context.filters],
            times: [...context.times],
          },
        };
        this.leaves.push(leaf);
      }
      return `[r${leaf.id}].[value]`;
    }
    if (node.name === "CALCULATE") {
      if (!node.args.length)
        throw new UnsupportedReferenceError("CALCULATE needs a measure input.");
      const next: Context = {
        ...context,
        removed: new Set(context.removed),
        filters: [...context.filters],
      };
      for (const filter of node.args.slice(1)) {
        if (
          filter.kind === "call" &&
          filter.name === "ALL" &&
          filter.args.length === 1 &&
          filter.args[0].kind === "column"
        ) {
          const col = resolveColumn(
              this.model,
              filter.args[0].tableName,
              filter.args[0].columnName,
            ),
            key = refKey(col.ref);
          next.removed.add(key);
          next.filters = next.filters.filter(
            (f) =>
              refKey(
                resolveColumn(this.model, f.attribute.table, f.attribute.column)
                  .ref,
              ) !== key,
          );
        } else {
          const checked = this.contextFilter(filter),
            key = refKey(checked.attribute);
          next.removed.add(key);
          next.filters = next.filters.filter(
            (f) =>
              refKey(
                resolveColumn(this.model, f.attribute.table, f.attribute.column)
                  .ref,
              ) !== key,
          );
          next.filters.push(checked);
        }
      }
      return this.expression(node.args[0], next);
    }
    if (times.has(node.name)) {
      if (!this.model.date)
        throw new UnsupportedReferenceError(
          `${node.name} cannot be reconciled without a date dimension.`,
        );
      if (node.args.length !== (node.name === "PREVIOUSPERIOD" ? 2 : 1))
        throw new UnsupportedReferenceError(`Invalid ${node.name} arguments.`);
      const period = node.name === "PREVIOUSPERIOD" ? node.args[1] : undefined;
      if (period && period.kind !== "period")
        throw new UnsupportedReferenceError(
          "PREVIOUSPERIOD needs MONTH, QUARTER or YEAR.",
        );
      return this.expression(node.args[0], {
        ...context,
        times: [
          ...context.times,
          {
            name: node.name,
            ...(period?.kind === "period" ? { period: period.value } : {}),
          },
        ],
      });
    }
    if (node.name === "DIVIDE") {
      if (node.args.length < 2 || node.args.length > 3)
        throw new UnsupportedReferenceError(
          "DIVIDE requires two inputs and an optional alternate value.",
        );
      const a = this.expression(node.args[0], context),
        b = this.expression(node.args[1], context),
        alternate = node.args[2]
          ? this.expression(node.args[2], context)
          : "NULL";
      return `(CASE WHEN ${b} IS NULL OR ${b} = 0 THEN ${alternate} ELSE 1.0 * ${a} / NULLIF(${b}, 0) END)`;
    }
    if (node.name === "IF" && node.args.length === 3)
      return `(CASE WHEN ${this.predicate(node.args[0], context)} THEN ${this.expression(node.args[1], context)} ELSE ${this.expression(node.args[2], context)} END)`;
    if (node.name === "ABS" && node.args.length === 1)
      return `ABS(${this.expression(node.args[0], context)})`;
    if (node.name === "ROUND" && node.args.length === 2)
      return `ROUND(${this.expression(node.args[0], context)}, ${this.expression(node.args[1], context)})`;
    throw new UnsupportedReferenceError(
      `${node.name} is not supported by the independent reference; add an oracle before treating it as verified.`,
    );
  }
  predicate(node: Expr, context: Context): string {
    if (node.kind === "literal" && typeof node.value === "boolean")
      return `${this.expression(node, context)} = 1`;
    return this.expression(node, context);
  }
  groupSet(context: Context): number[] {
    return this.groups.flatMap((g, i) =>
      context.removed.has(refKey(g.ref)) ? [] : [i],
    );
  }
  filters(context: Context, removeDate = false): QueryFilter[] {
    const overrideKeys = new Set(
      context.filters.map((f) => refKey(f.attribute)),
    );
    return [
      ...this.query.filters.filter((f) => {
        const r = resolveColumn(
          this.model,
          f.attribute.table,
          f.attribute.column,
        ).ref;
        return !context.removed.has(refKey(r)) && !overrideKeys.has(refKey(r));
      }),
      ...context.filters,
    ].filter(
      (f) =>
        !removeDate ||
        resolveColumn(this.model, f.attribute.table, f.attribute.column).table
          .id !== this.model.date?.tableId,
    );
  }
  relation(
    groups: number[],
    filters: QueryFilter[],
    column?: ResolvedColumn | null,
    date = false,
  ): { from: string; where: string; group: string[] } {
    const required = new Set<string>(
      groups.map((i) => this.groups[i].table.id),
    );
    if (column) required.add(column.table.id);
    if (date && this.model.date) required.add(this.model.date.tableId);
    const predicates = filters.map((f) => this.filter(f, required));
    const joined = this.from(required);
    predicates.push(...joined.unknown);
    return {
      from: joined.sql,
      where: predicates.length
        ? `\nWHERE ${predicates.map((p) => `(${p})`).join(" AND ")}`
        : "",
      group: groups.map((i) => this.physical(this.groups[i])),
    };
  }
  aggregate(leaf: Leaf): string {
    const value = leaf.column ? this.physical(leaf.column) : "*";
    if (leaf.aggregate === "DISTINCTCOUNT")
      return `COUNT_BIG(DISTINCT ${value})`;
    if (leaf.aggregate === "SUM" || leaf.aggregate === "AVG")
      return `${leaf.aggregate}(CONVERT(decimal(38, 10), ${value}))`;
    return `${leaf.aggregate}(${value})`;
  }
  normal(leaf: Leaf): string {
    const groups = this.groupSet(leaf.context),
      r = this.relation(groups, this.filters(leaf.context), leaf.column);
    return `SELECT ${groups.map((index, i) => `${r.group[i]} AS [g${index}], `).join("")}${this.aggregate(leaf)} AS [value]\n${r.from}${r.where}${r.group.length ? `\nGROUP BY ${r.group.join(", ")}` : ""}`;
  }
  nullJoin(left: string, right: string, index: number): string {
    const group = this.groups[index],
      sentinel =
        group.column.type === "number"
          ? "0"
          : group.column.type === "boolean"
            ? "CAST(0 AS bit)"
            : group.column.type === "date"
              ? "CONVERT(date, '00010101', 112)"
              : "N''";
    const a = `[${left}].[g${index}]`,
      b = `[${right}].[g${index}]`;
    return `(CASE WHEN ${a} IS NULL THEN 1 ELSE 0 END) = (CASE WHEN ${b} IS NULL THEN 1 ELSE 0 END) AND COALESCE(${a}, ${sentinel}) = COALESCE(${b}, ${sentinel})`;
  }
  temporal(leaf: Leaf): string {
    if (leaf.aggregate === "DISTINCTCOUNT")
      throw new UnsupportedReferenceError(
        "Time-shifted DISTINCTCOUNT needs a distinct-set oracle; daily counts cannot be added safely.",
      );
    const date = resolveColumn(
        this.model,
        this.model.date!.tableId,
        this.model.date!.dateColumnId,
      ),
      groups = this.groupSet(leaf.context);
    if (
      this.filters(leaf.context).some(
        (filter) =>
          resolveColumn(
            this.model,
            filter.attribute.table,
            filter.attribute.column,
          ).table.id === date.table.id,
      )
    )
      throw new UnsupportedReferenceError(
        "Time intelligence with explicit date-dimension filters needs an independent set-of-dates oracle; it is not treated as a full calendar period.",
      );
    const nongroups = groups.filter(
      (i) => this.groups[i].table.id !== date.table.id,
    );
    const anchor = this.relation(
      groups,
      this.filters(leaf.context),
      null,
      true,
    );
    const dateGroups = groups.filter(
      (i) => this.groups[i].table.id === date.table.id,
    );
    const year = dateGroups.find(
      (i) => this.groups[i].column.name.toLowerCase() === "year",
    );
    const month = dateGroups.find(
      (i) => this.groups[i].column.name.toLowerCase() === "month",
    );
    const quarter = dateGroups.find(
      (i) => this.groups[i].column.name.toLowerCase() === "quarter",
    );
    const exactDate = dateGroups.find(
      (i) => this.groups[i].column.id === date.column.id,
    );
    if (
      exactDate === undefined &&
      dateGroups.length &&
      (year === undefined ||
        dateGroups.some(
          (i) =>
            !["year", "month", "quarter"].includes(
              this.groups[i].column.name.toLowerCase(),
            ),
        ))
    )
      throw new UnsupportedReferenceError(
        "Time intelligence over a noncontiguous calendar attribute needs a set-of-dates oracle. Use Year, Year + Month, Year + Quarter, or the complete Date attribute.",
      );
    let anchorStart = `MIN(${this.physical(date)})`,
      anchorEnd = `MAX(${this.physical(date)})`;
    if (exactDate === undefined && year !== undefined) {
      const y = this.physical(this.groups[year]),
        m =
          month !== undefined
            ? this.physical(this.groups[month])
            : quarter !== undefined
              ? `(${this.physical(this.groups[quarter])} - 1) * 3 + 1`
              : "1";
      anchorStart = `DATEFROMPARTS(${y}, ${m}, 1)`;
      anchorEnd = `DATEADD(DAY, -1, DATEADD(${month !== undefined ? "MONTH" : quarter !== undefined ? "QUARTER" : "YEAR"}, 1, ${anchorStart}))`;
    }
    const anchorSql = `SELECT ${groups.map((index, i) => `${anchor.group[i]} AS [g${index}], `).join("")}${anchorStart} AS [start_date], ${anchorEnd} AS [end_date]\n${anchor.from}${anchor.where}${anchor.group.length ? `\nGROUP BY ${anchor.group.join(", ")}` : ""}`;
    const daily = this.relation(
        nongroups,
        this.filters(leaf.context, true),
        leaf.column,
        true,
      ),
      day = `CONVERT(date, ${this.physical(date)})`;
    const input = leaf.column ? this.physical(leaf.column) : "*";
    const amount =
      leaf.aggregate === "AVG"
        ? `SUM(CONVERT(decimal(38, 10), ${input}))`
        : this.aggregate(leaf);
    const dailySql = `SELECT ${nongroups.map((index, i) => `${daily.group[i]} AS [g${index}], `).join("")}${day} AS [day], ${amount} AS [amount]${leaf.aggregate === "AVG" ? `, COUNT_BIG(${input}) AS [quantity]` : ""}\n${daily.from}${daily.where}\nGROUP BY ${[...daily.group, day].join(", ")}`;
    let start = "[p].[start_date]",
      end = "[p].[end_date]";
    const beginning = (unit: string, value: string) =>
      unit === "YEAR"
        ? `DATEFROMPARTS(YEAR(${value}), 1, 1)`
        : unit === "QUARTER"
          ? `DATEFROMPARTS(YEAR(${value}), ((MONTH(${value}) - 1) / 3) * 3 + 1, 1)`
          : `DATEFROMPARTS(YEAR(${value}), MONTH(${value}), 1)`;
    for (const transform of leaf.context.times) {
      if (transform.name === "YTD") start = beginning("YEAR", end);
      else if (transform.name === "MTD") start = beginning("MONTH", end);
      else if (transform.name === "QTD") start = beginning("QUARTER", end);
      else if (transform.name === "SAMEPERIODLASTYEAR") {
        start = `DATEADD(YEAR, -1, ${start})`;
        end = `DATEADD(YEAR, -1, ${end})`;
      } else {
        const first = beginning(transform.period!, start);
        start = `DATEADD(${transform.period}, -1, ${first})`;
        end = `DATEADD(DAY, -1, ${first})`;
      }
    }
    const partition = groups.length
      ? `PARTITION BY ${groups.map((i) => `[p].[g${i}]`).join(", ")}`
      : "";
    const fn =
      leaf.aggregate === "MIN"
        ? "MIN"
        : leaf.aggregate === "MAX"
          ? "MAX"
          : "SUM";
    let result = `${fn}([days].[amount]) OVER (${partition})`;
    if (leaf.aggregate === "AVG")
      result = `1.0 * ${result} / NULLIF(SUM([days].[quantity]) OVER (${partition}), 0)`;
    if (["COUNT", "COUNT_BIG"].includes(leaf.aggregate))
      result = `COALESCE(${result}, 0)`;
    const predicates = [
      ...nongroups.map((i) => this.nullJoin("p", "days", i)),
      `[days].[day] BETWEEN ${start} AND ${end}`,
    ];
    return `SELECT DISTINCT ${groups.map((i) => `[p].[g${i}], `).join("")}${result} AS [value]\nFROM (\n${anchorSql}\n) AS [p]\nLEFT JOIN (\n${dailySql}\n) AS [days] ON ${predicates.map((p) => `(${p})`).join(" AND ")}`;
  }
  resultType(node: Expr, path = new Set<string>()): SemanticType {
    if (node.kind === "measure") {
      const measure = referenceMeasure(this.model, node.name);
      if (path.has(measure.id))
        throw new UnsupportedReferenceError("Measure reference cycle.");
      path.add(measure.id);
      try {
        return this.resultType(astFor(this.model, measure.id), path);
      } finally {
        path.delete(measure.id);
      }
    }
    if (node.kind === "column")
      return resolveColumn(this.model, node.tableName, node.columnName).column
        .type;
    if (node.kind === "literal")
      return typeof node.value === "string"
        ? "string"
        : typeof node.value === "boolean"
          ? "boolean"
          : "number";
    if (node.kind === "call") {
      if (["MIN", "MAX", "CALCULATE", ...times].includes(node.name))
        return this.resultType(node.args[0], path);
      if (node.name === "IF") return this.resultType(node.args[1], path);
      return "number";
    }
    if (
      node.kind === "in" ||
      (node.kind === "unary" && node.op === "NOT") ||
      (node.kind === "binary" &&
        ["=", "!=", "<>", ">", ">=", "<", "<=", "AND", "OR"].includes(node.op))
    )
      return "boolean";
    return "number";
  }
  build(): ReferenceSql {
    if (!this.query.measures.length)
      throw new UnsupportedReferenceError(
        "Select at least one measure for reconciliation.",
      );
    if (
      !Number.isInteger(this.query.limit) ||
      this.query.limit < 1 ||
      this.query.limit > 100000
    )
      throw new UnsupportedReferenceError(
        "Independent reference limits must be from 1 to 100,000 rows.",
      );
    const context: Context = { removed: new Set(), filters: [], times: [] };
    const expressions = this.query.measures.map((name) => {
      const m = referenceMeasure(this.model, name);
      this.expansions.add(m.id);
      try {
        return this.expression(astFor(this.model, m.id), context);
      } finally {
        this.expansions.delete(m.id);
      }
    });
    const allGroups = this.groups.map((_, i) => i),
      anchor = this.relation(allGroups, this.query.filters);
    const anchorSql = this.groups.length
      ? `SELECT DISTINCT ${anchor.group.map((g, i) => `${g} AS [g${i}]`).join(", ")}\n${anchor.from}${anchor.where}`
      : "SELECT 1 AS [one]";
    const joins = this.leaves.map((leaf) => {
      const groups = this.groupSet(leaf.context),
        on = groups.length
          ? groups
              .map((i) => `(${this.nullJoin("anchor", `r${leaf.id}`, i)})`)
              .join(" AND ")
          : "1 = 1";
      return `LEFT JOIN (\n${leaf.context.times.length ? this.temporal(leaf) : this.normal(leaf)}\n) AS [r${leaf.id}] ON ${on}`;
    });
    const limit = Math.min(this.query.limit + 1, 100001);
    this.params.push({ name: "__df_limit", value: limit, type: "number" });
    const selected = [
      ...this.groups.map((_, i) => `[anchor].[g${i}] AS [g${i}]`),
      ...expressions.map((e, i) => `${e} AS [v${i}]`),
    ];
    const order = this.query.orderBy.map((sort) => {
      if (typeof sort.ref === "string") {
        const target = referenceMeasure(this.model, sort.ref),
          index = this.query.measures.findIndex(
            (n) => referenceMeasure(this.model, n).id === target.id,
          );
        if (index < 0)
          throw new UnsupportedReferenceError(
            "Reference sorting measure must be selected.",
          );
        return `[v${index}] ${sort.dir === "desc" ? "DESC" : "ASC"}`;
      }
      const ref = resolveColumn(
          this.model,
          sort.ref.table,
          sort.ref.column,
        ).ref,
        index = this.groups.findIndex((g) => refKey(g.ref) === refKey(ref));
      if (index < 0)
        throw new UnsupportedReferenceError(
          "Reference sorting attribute must be grouped.",
        );
      return `[g${index}] ${sort.dir === "desc" ? "DESC" : "ASC"}`;
    });
    const sql = `SELECT TOP (@__df_limit) ${selected.join(", ")}\nFROM (\n${anchorSql}\n) AS [anchor]${joins.length ? "\n" + joins.join("\n") : ""}${order.length ? "\nORDER BY " + order.join(", ") : ""};`;
    if (sql.length > 750000)
      throw new UnsupportedReferenceError(
        "Independent reference SQL exceeds its size budget.",
      );
    return {
      sql,
      params: this.params,
      limit: this.query.limit,
      columns: [
        ...this.groups.map((g, i) => ({
          key: `g${i}`,
          name: g.column.name,
          type: g.column.type,
          role: "attribute" as const,
        })),
        ...this.query.measures.map((m, i) => ({
          key: `v${i}`,
          name: referenceMeasure(this.model, m).name,
          type: this.resultType(astFor(this.model, m)),
          role: "measure" as const,
        })),
      ],
    };
  }
}
export function buildReferenceQuery(
  model: SemanticModel,
  query: SemanticQuery,
): ReferenceSql {
  return new ReferenceBuilder(model, query).build();
}
