import type {
  SemanticColumn,
  SemanticModel,
  SemanticTable,
  SqlParameter,
} from "../types";
import { AGGREGATIONS, resolveExpression, TIME_FUNCTIONS } from "./checker";
import { ExpressionError, type Period, type ResolvedExpr } from "./types";

const quote = (identifier: string) => `[${identifier.replace(/\]/g, "]]")}]`;
interface Context {
  filters: ResolvedExpr[];
  period?: string;
}

/** A standalone no-grouping SELECT preview. Query compilation uses the same resolved AST. */
export function compile(expression: string, model: SemanticModel) {
  const checked = resolveExpression(expression, model);
  const fact = model.tables.find((table) => table.id === model.factTableId);
  if (!fact) throw new ExpressionError("The semantic model has no fact table");
  const parameters: SqlParameter[] = [];
  const parameterNames = new Map<string, string>();
  const required = new Set<string>();
  const guardSql = (sql: string) => {
    if (sql.length > 262_144)
      throw new ExpressionError(
        "Compiled expression is too complex (maximum 256 KiB of SQL)",
      );
    return sql;
  };
  function collect(node: ResolvedExpr) {
    if (node.kind === "column") required.add(node.table.id);
    else if (node.kind === "measure") collect(node.expression);
    else if (node.kind === "call") {
      if (TIME_FUNCTIONS.has(node.name) && model.date)
        required.add(model.date.tableId);
      node.args.forEach(collect);
    } else if (node.kind === "unary") collect(node.operand);
    else if (node.kind === "binary") {
      collect(node.left);
      collect(node.right);
    } else if (node.kind === "in") {
      collect(node.expression);
      node.values.forEach(collect);
    }
  }
  collect(checked.ast);
  const aliases = new Map<string, string>([[fact.id, "f"]]);
  const dimensions = model.tables.filter(
    (table) => table.kind === "dimension" && required.has(table.id),
  );
  dimensions.forEach((table, index) => aliases.set(table.id, `d${index}`));
  function columnSql(table: SemanticTable, column: SemanticColumn) {
    const alias = aliases.get(table.id);
    if (!alias)
      throw new ExpressionError(
        "The expression references a table without a fact relationship",
      );
    return `${quote(alias)}.${quote(column.sqlName)}`;
  }
  const from = [
    `FROM ${quote(fact.schema)}.${quote(fact.sqlName)} AS [f]`,
    ...dimensions.map((dimension) => {
      const links = model.relationships.filter(
        (link) =>
          link.fromTableId === fact.id && link.toTableId === dimension.id,
      );
      const link =
        links.find(
          (item) =>
            dimension.id === model.date?.tableId &&
            item.fromColumnId === model.date.factColumnId,
        ) ?? links[0];
      const factColumn = fact.columns.find(
        (column) => column.id === link?.fromColumnId,
      );
      const dimensionColumn = dimension.columns.find(
        (column) => column.id === link?.toColumnId,
      );
      if (!link || !factColumn || !dimensionColumn)
        throw new ExpressionError(
          `Table ${dimension.name} has no valid fact relationship`,
        );
      return `LEFT JOIN ${quote(dimension.schema)}.${quote(dimension.sqlName)} AS ${quote(aliases.get(dimension.id)!)} ON ${columnSql(fact, factColumn)} = ${columnSql(dimension, dimensionColumn)}`;
    }),
  ].join("\n");
  function parameter(value: string | number | boolean | null): string {
    const key = `${typeof value}:${JSON.stringify(value)}`;
    const cached = parameterNames.get(key);
    if (cached) return cached;
    const name = `p${parameters.length}`;
    if (parameters.length >= 1_900)
      throw new ExpressionError(
        "Compiled expression exceeds the 1,900-parameter limit",
      );
    parameters.push({
      name,
      value,
      ...(value !== null
        ? {
            type:
              typeof value === "number"
                ? ("number" as const)
                : typeof value === "boolean"
                  ? ("boolean" as const)
                  : ("string" as const),
          }
        : {}),
    });
    parameterNames.set(key, `@${name}`);
    return `@${name}`;
  }
  function filterColumns(node: ResolvedExpr): string[] {
    if (node.kind === "column") return [node.column.id];
    if (node.kind === "binary")
      return [...filterColumns(node.left), ...filterColumns(node.right)];
    if (node.kind === "in") return filterColumns(node.expression);
    if (node.kind === "call") return node.args.flatMap(filterColumns);
    return [];
  }
  function where(context: Context) {
    const filters = context.filters.map((filter) => predicate(filter, context));
    if (context.period) filters.push(context.period);
    return filters.length
      ? `\nWHERE ${filters.map((filter) => `(${filter})`).join(" AND ")}`
      : "";
  }
  function select(value: string, context: Context) {
    return guardSql(`(SELECT ${value}\n${from}${where(context)})`);
  }
  function predicate(node: ResolvedExpr, context: Context): string {
    if (node.kind === "measure") return predicate(node.expression, context);
    if (node.kind === "unary" && node.op === "NOT")
      return `(NOT ${predicate(node.operand, context)})`;
    if (node.kind === "binary") {
      if (node.op === "AND" || node.op === "OR")
        return `(${predicate(node.left, context)} ${node.op} ${predicate(node.right, context)})`;
      if (["=", "<>", "!=", "<", "<=", ">", ">="].includes(node.op)) {
        if (
          node.right.kind === "literal" &&
          node.right.value === null &&
          ["=", "<>", "!="].includes(node.op)
        )
          return `(${render(node.left, context)} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
        if (
          node.left.kind === "literal" &&
          node.left.value === null &&
          ["=", "<>", "!="].includes(node.op)
        )
          return `(${render(node.right, context)} IS ${node.op === "=" ? "" : "NOT "}NULL)`;
        return `(${render(node.left, context)} ${node.op === "!=" ? "<>" : node.op} ${render(node.right, context)})`;
      }
    }
    if (node.kind === "in") {
      const nonNull = node.values.filter(
        (value) => !(value.kind === "literal" && value.value === null),
      );
      const containsNull = nonNull.length !== node.values.length;
      const value = render(node.expression, context);
      const parts: string[] = [];
      if (nonNull.length)
        parts.push(
          `${value} ${node.negated ? "NOT " : ""}IN (${nonNull.map((item) => render(item, context)).join(", ")})`,
        );
      if (containsNull)
        parts.push(`${value} IS ${node.negated ? "NOT " : ""}NULL`);
      return `(${parts.join(node.negated ? " AND " : " OR ")})`;
    }
    return `(${render(node, context)} = CAST(1 AS BIT))`;
  }
  function dateExpression() {
    const table = model.tables.find((item) => item.id === model.date?.tableId);
    const column = table?.columns.find(
      (item) => item.id === model.date?.dateColumnId,
    );
    if (!table || !column)
      throw new ExpressionError("Time intelligence requires a date column");
    return columnSql(table, column);
  }
  function periodStart(anchor: string, unit: Period) {
    return unit === "YEAR"
      ? `DATEFROMPARTS(YEAR(${anchor}), 1, 1)`
      : unit === "QUARTER"
        ? `DATEFROMPARTS(YEAR(${anchor}), (DATEPART(QUARTER, ${anchor}) - 1) * 3 + 1, 1)`
        : `DATEFROMPARTS(YEAR(${anchor}), MONTH(${anchor}), 1)`;
  }
  function time(
    node: Extract<ResolvedExpr, { kind: "call" }>,
    context: Context,
  ) {
    const date = dateExpression();
    const max = select(`MAX(${date})`, context);
    const min = select(`MIN(${date})`, context);
    let condition: string;
    if (node.name === "SAMEPERIODLASTYEAR")
      condition = `${date} >= DATEADD(YEAR, -1, ${min}) AND ${date} <= DATEADD(YEAR, -1, ${max})`;
    else if (node.name === "PREVIOUSPERIOD") {
      const unit =
        node.args[1].kind === "period" ? node.args[1].value : "MONTH";
      const start = periodStart(max, unit);
      condition = `${date} >= DATEADD(${unit}, -1, ${start}) AND ${date} < ${start}`;
    } else {
      const unit: Period =
        node.name === "YTD"
          ? "YEAR"
          : node.name === "QTD"
            ? "QUARTER"
            : "MONTH";
      condition = `${date} >= ${periodStart(max, unit)} AND ${date} <= ${max}`;
    }
    guardSql(condition);
    return render(node.args[0], {
      filters: context.filters.filter(
        (filter) =>
          !filterColumns(filter).some((id) =>
            model.tables
              .find((table) => table.id === model.date?.tableId)
              ?.columns.some((column) => column.id === id),
          ),
      ),
      period: condition,
    });
  }
  function render(node: ResolvedExpr, context: Context): string {
    return guardSql(renderInner(node, context));
  }
  function renderInner(node: ResolvedExpr, context: Context): string {
    if (node.kind === "literal")
      return node.value === null ? "NULL" : parameter(node.value);
    if (node.kind === "column") return columnSql(node.table, node.column);
    if (node.kind === "measure") return render(node.expression, context);
    if (node.kind === "unary")
      return node.op === "NOT"
        ? `(CASE WHEN ${predicate(node, context)} THEN CAST(1 AS BIT) WHEN NOT (${predicate(node, context)}) THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`
        : `(${node.op}${render(node.operand, context)})`;
    if (
      node.kind === "in" ||
      (node.kind === "binary" && !["+", "-", "*", "/", "%"].includes(node.op))
    )
      return `(CASE WHEN ${predicate(node, context)} THEN CAST(1 AS BIT) WHEN NOT (${predicate(node, context)}) THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`;
    if (node.kind === "binary")
      return node.op === "/"
        ? `(CAST(${render(node.left, context)} AS FLOAT) / NULLIF(${render(node.right, context)}, 0))`
        : `(${render(node.left, context)} ${node.op} ${render(node.right, context)})`;
    if (node.kind !== "call")
      throw new ExpressionError(
        "Invalid scalar expression",
        node.pos,
        node.end,
      );
    if (AGGREGATIONS.has(node.name)) {
      const rawArgument =
        node.args[0].kind === "star" ? "*" : render(node.args[0], context);
      const argument =
        node.name === "AVG"
          ? `CAST(${rawArgument} AS FLOAT)`
          : node.name === "SUM"
            ? `CAST(${rawArgument} AS DECIMAL(38, 10))`
            : rawArgument;
      const name =
        node.name === "COUNT"
          ? "COUNT_BIG"
          : node.name === "DISTINCTCOUNT"
            ? "COUNT_BIG"
            : node.name;
      return select(
        `${name}(${node.name === "DISTINCTCOUNT" ? "DISTINCT " : ""}${argument})`,
        context,
      );
    }
    if (node.name === "CALCULATE") {
      let filters = [...context.filters];
      for (const filter of node.args.slice(1)) {
        const ids = new Set(filterColumns(filter));
        filters = filters.filter(
          (previous) => !filterColumns(previous).some((id) => ids.has(id)),
        );
        if (!(filter.kind === "call" && filter.name === "ALL"))
          filters.push(filter);
      }
      return render(node.args[0], { ...context, filters });
    }
    if (TIME_FUNCTIONS.has(node.name)) return time(node, context);
    if (node.name === "DIVIDE") {
      const denominator = render(node.args[1], context);
      return `(CASE WHEN ${denominator} IS NULL OR ${denominator} = 0 THEN ${node.args[2] ? render(node.args[2], context) : "NULL"} ELSE CAST(${render(node.args[0], context)} AS FLOAT) / NULLIF(${denominator}, 0) END)`;
    }
    if (node.name === "IF")
      return `(CASE WHEN ${predicate(node.args[0], context)} THEN ${render(node.args[1], context)} ELSE ${render(node.args[2], context)} END)`;
    if (node.name === "ABS" || node.name === "ROUND")
      return `${node.name}(${node.args.map((argument) => render(argument, context)).join(", ")})`;
    throw new ExpressionError("Invalid scalar function", node.pos, node.end);
  }
  const value = render(checked.ast, { filters: [] });
  return {
    sql: guardSql(`SELECT ${value} AS [value];`),
    params: parameters,
    dependencies: checked.dependencies,
    ast: checked.ast,
    type: checked.type,
  };
}
export const compileExpression = compile;
