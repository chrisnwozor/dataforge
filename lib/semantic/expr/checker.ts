import type { SemanticModel } from "../types";
import { parse } from "./parser";
import {
  resolutionNamespace,
  type ResolvedCacheEntry,
  type ResolutionNamespace,
} from "./resolution-cache";
import {
  ExpressionError,
  type Expr,
  type ExprType,
  type ResolvedExpr,
} from "./types";

export const AGGREGATIONS = new Set([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "COUNT_BIG",
  "DISTINCTCOUNT",
]);
export const TIME_FUNCTIONS = new Set([
  "YTD",
  "MTD",
  "QTD",
  "SAMEPERIODLASTYEAR",
  "PREVIOUSPERIOD",
]);
const FUNCTIONS = [
  ...AGGREGATIONS,
  ...TIME_FUNCTIONS,
  "DIVIDE",
  "IF",
  "ABS",
  "ROUND",
  "CALCULATE",
  "ALL",
];
const fold = (name: string) => name.toLocaleLowerCase("en-US");

function nameIndex<T>(values: T[], names: (value: T) => string[]) {
  const index = new Map<string, T[]>();
  for (const value of values)
    for (const name of new Set(names(value).map(fold))) {
      const matches = index.get(name);
      if (matches) matches.push(value);
      else index.set(name, [value]);
    }
  return index;
}

function buildIndexes(model: SemanticModel) {
  return {
    tables: nameIndex(model.tables, (table) => [
      table.id,
      table.name,
      table.sqlName,
    ]),
    columns: new Map(
      model.tables.map((table) => [
        table.id,
        nameIndex(table.columns, (column) => [
          column.id,
          column.name,
          column.sqlName,
        ]),
      ]),
    ),
    measures: nameIndex(model.measures, (measure) => [
      measure.id,
      measure.name,
    ]),
    measuresById: new Map(
      model.measures.map((measure) => [measure.id, measure]),
    ),
  };
}
const modelIndexes = new WeakMap<
  ResolutionNamespace,
  ReturnType<typeof buildIndexes>
>();

function immutableAst(node: ResolvedExpr): ResolvedExpr {
  // Children were frozen when built; metadata was snapshotted once per model.
  if (node.kind === "call") Object.freeze(node.args);
  if (node.kind === "in") Object.freeze(node.values);
  return Object.freeze(node);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  return row[b.length];
}
function closest(name: string, choices: string[]): string | undefined {
  const threshold = Math.max(2, Math.floor(name.length * 0.4));
  if (name.length > 256) return undefined;
  const ordered = choices
    .filter((choice) => Math.abs(choice.length - name.length) <= threshold)
    .slice(0, 256)
    .map((choice) => ({
      choice,
      distance: distance(name.toLowerCase(), choice.toLowerCase()),
    }))
    .sort((a, b) => a.distance - b.distance);
  return ordered[0] && ordered[0].distance <= threshold
    ? ordered[0].choice
    : undefined;
}
function fail(node: Expr | ResolvedExpr, message: string): never {
  throw new ExpressionError(message, node.pos, node.end);
}
function numeric(node: ResolvedExpr) {
  if (node.type !== "number" && node.type !== "null")
    fail(node, "A numeric expression is required");
}
function boolean(node: ResolvedExpr) {
  if (node.type !== "boolean" && node.type !== "null")
    fail(node, "A boolean condition is required");
}
function compatible(left: ResolvedExpr, right: ResolvedExpr) {
  if (left.type === right.type || left.type === "null" || right.type === "null")
    return;
  if (
    (left.type === "date" && right.type === "string") ||
    (right.type === "date" && left.type === "string")
  ) {
    const value = left.type === "string" ? left : right;
    if (
      value.kind !== "literal" ||
      typeof value.value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value.value)
    )
      fail(value, "Date comparisons require an ISO YYYY-MM-DD literal");
    const parsed = new Date(`${value.value}T00:00:00.000Z`);
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value.value ||
      value.value.startsWith("0000")
    )
      fail(value, "Date comparisons require a valid calendar date");
    return;
  }
  fail(right, `Cannot compare ${left.type} and ${right.type} values`);
}
function literalValue(node: ResolvedExpr): boolean {
  return (
    node.kind === "literal" ||
    (node.kind === "unary" &&
      (node.op === "+" || node.op === "-") &&
      node.operand.kind === "literal" &&
      node.operand.type === "number")
  );
}
function validateFilter(node: ResolvedExpr): void {
  if (node.kind === "call" && node.name === "ALL") return;
  if (node.kind === "binary" && (node.op === "AND" || node.op === "OR")) {
    validateFilter(node.left);
    validateFilter(node.right);
    return;
  }
  if (
    node.kind === "binary" &&
    ["=", "<>", "!=", "<", "<=", ">", ">="].includes(node.op)
  ) {
    if (node.left.kind !== "column" || !literalValue(node.right))
      fail(
        node,
        "CALCULATE filters must compare Table[Column] to a literal value",
      );
    compatible(node.left, node.right);
    return;
  }
  if (
    node.kind === "in" &&
    node.expression.kind === "column" &&
    node.values.every(literalValue)
  ) {
    for (const value of node.values) compatible(node.expression, value);
    return;
  }
  fail(
    node,
    "CALCULATE expects column comparisons, IN filters, or ALL(Table[Column])",
  );
}
function validateScalar(node: ResolvedExpr): void {
  if (node.kind === "column")
    fail(
      node,
      "Columns must be aggregated before they can be used as a measure",
    );
  if (node.kind === "period" || node.kind === "star" || node.type === "filter")
    fail(node, "This value is only valid inside its function");
  if (node.kind === "call") {
    if (AGGREGATIONS.has(node.name)) return;
    validateScalar(node.args[0]);
    if (node.name === "CALCULATE") return;
    for (const argument of node.args.slice(1))
      if (argument.kind !== "period") validateScalar(argument);
  } else if (node.kind === "binary") {
    validateScalar(node.left);
    validateScalar(node.right);
  } else if (node.kind === "unary") validateScalar(node.operand);
  else if (node.kind === "in") {
    validateScalar(node.expression);
    node.values.forEach(validateScalar);
  }
}

export interface CheckedExpression {
  ast: ResolvedExpr;
  type: ExprType;
  dependencies: string[];
}

export interface ExpressionResolver {
  resolve(expression: string): CheckedExpression;
  resolveMeasure(id: string): CheckedExpression;
}

/** Share immutable expansion DAGs across selected measures and model versions. */
export function createExpressionResolver(
  sourceModel: SemanticModel,
): ExpressionResolver {
  const namespace = resolutionNamespace(sourceModel);
  const model = namespace.model;
  let indexes = modelIndexes.get(namespace);
  if (!indexes) {
    indexes = buildIndexes(model);
    modelIndexes.set(namespace, indexes);
  }
  const lookup = indexes;

  function resolveSource(
    expression: string,
    active: string[],
  ): ResolvedCacheEntry {
    const dependencies = new Set<string>();
    let expandedNodes = 0;
    function visit(node: Expr): ResolvedExpr {
      return immutableAst(visitNode(node));
    }
    function visitNode(node: Expr): ResolvedExpr {
      expandedNodes++;
      if (expandedNodes > 10_000)
        fail(node, "Expanded expression is too complex (maximum 10,000 nodes)");
      const span = { pos: node.pos, end: node.end };
      if (node.kind === "literal")
        return {
          ...node,
          type:
            node.value === null
              ? "null"
              : typeof node.value === "number"
                ? "number"
                : typeof node.value === "boolean"
                  ? "boolean"
                  : "string",
        };
      if (node.kind === "period") return { ...node, type: "period" };
      if (node.kind === "star") return { ...node, type: "star" };
      if (node.kind === "column") {
        const tables = lookup.tables.get(fold(node.tableName)) ?? [];
        if (!tables.length)
          throw new ExpressionError(
            `Unknown table ${JSON.stringify(node.tableName)}`,
            node.pos,
            node.end,
            closest(
              node.tableName,
              model.tables.map((table) => table.sqlName),
            ),
          );
        if (tables.length > 1)
          fail(node, "The table reference is ambiguous; use its unique ID");
        const table = tables[0];
        const columns =
          lookup.columns.get(table.id)?.get(fold(node.columnName)) ?? [];
        if (!columns.length)
          throw new ExpressionError(
            `Unknown column ${JSON.stringify(node.columnName)} in ${JSON.stringify(table.name)}`,
            node.pos,
            node.end,
            closest(
              node.columnName,
              table.columns.map((column) => column.name),
            ),
          );
        if (columns.length > 1)
          fail(node, "The column reference is ambiguous; use its unique ID");
        return {
          kind: "column",
          table,
          column: columns[0],
          type: columns[0].type,
          ...span,
        };
      }
      if (node.kind === "measure") {
        const matches = lookup.measures.get(fold(node.name)) ?? [];
        if (!matches.length)
          throw new ExpressionError(
            `Unknown measure ${JSON.stringify(node.name)}`,
            node.pos,
            node.end,
            closest(
              node.name,
              model.measures.map((measure) => measure.name),
            ),
          );
        if (matches.length > 1)
          fail(node, "The measure reference is ambiguous; use its unique ID");
        const measure = matches[0];
        if (active.includes(measure.id)) {
          const names = [...active, measure.id].map(
            (id) => lookup.measuresById.get(id)?.name ?? id,
          );
          fail(node, `Measure cycle detected: ${names.join(" → ")}`);
        }
        const saved = resolveSavedMeasure(measure.id, active);
        dependencies.add(measure.id);
        for (const id of saved.dependencies) dependencies.add(id);
        if (dependencies.size > 64)
          fail(node, "An expression may reference at most 64 measures");
        expandedNodes += saved.cost;
        if (expandedNodes > 10_000)
          fail(
            node,
            "Expanded expression is too complex (maximum 10,000 nodes)",
          );
        return {
          kind: "measure",
          measure,
          expression: saved.ast,
          type: saved.ast.type,
          ...span,
        };
      }
      if (node.kind === "unary") {
        const operand = visit(node.operand);
        if (node.op === "NOT") boolean(operand);
        else numeric(operand);
        return {
          ...node,
          operand,
          type: node.op === "NOT" ? "boolean" : "number",
        };
      }
      if (node.kind === "binary") {
        const left = visit(node.left),
          right = visit(node.right);
        let type: ExprType;
        if (["+", "-", "*", "/", "%"].includes(node.op)) {
          numeric(left);
          numeric(right);
          type = "number";
        } else if (node.op === "AND" || node.op === "OR") {
          boolean(left);
          boolean(right);
          type = "boolean";
        } else {
          compatible(left, right);
          type = "boolean";
        }
        return { ...node, left, right, type };
      }
      if (node.kind === "in") {
        const value = visit(node.expression),
          values = node.values.map(visit);
        values.forEach((item) => compatible(value, item));
        return { ...node, expression: value, values, type: "boolean" };
      }
      if (!FUNCTIONS.includes(node.name))
        throw new ExpressionError(
          `Unknown function ${node.name}`,
          node.pos,
          node.end,
          closest(node.name, FUNCTIONS),
        );
      const args = node.args.map(visit);
      const count = (minimum: number, maximum = minimum) => {
        if (args.length < minimum || args.length > maximum)
          fail(
            node,
            `${node.name} expects ${minimum === maximum ? minimum : `${minimum}–${maximum}`} argument${maximum === 1 ? "" : "s"}`,
          );
      };
      let type: ExprType = "number";
      if (AGGREGATIONS.has(node.name)) {
        count(1);
        const column = args[0];
        if (column.kind === "star") {
          if (node.name !== "COUNT_BIG" && node.name !== "COUNT")
            fail(column, "Only COUNT_BIG(*) and COUNT(*) accept *");
        } else {
          if (column.kind !== "column" || column.table.id !== model.factTableId)
            fail(column, "Aggregations require a fact-table column");
          if (node.name === "SUM" || node.name === "AVG") numeric(column);
          if (
            (node.name === "MIN" || node.name === "MAX") &&
            column.type === "boolean"
          )
            fail(column, "MIN/MAX do not support boolean columns; use COUNT");
          if (node.name === "MIN" || node.name === "MAX") type = column.type;
        }
      } else if (node.name === "DIVIDE") {
        count(2, 3);
        args.forEach(numeric);
      } else if (node.name === "IF") {
        count(3);
        boolean(args[0]);
        compatible(args[1], args[2]);
        type = args[1].type === "null" ? args[2].type : args[1].type;
      } else if (node.name === "ABS") {
        count(1);
        numeric(args[0]);
      } else if (node.name === "ROUND") {
        count(2);
        numeric(args[0]);
        numeric(args[1]);
        const precision =
          args[1].kind === "literal"
            ? args[1].value
            : args[1].kind === "unary" &&
                args[1].operand.kind === "literal" &&
                typeof args[1].operand.value === "number"
              ? (args[1].op === "-" ? -1 : 1) * args[1].operand.value
              : undefined;
        if (
          typeof precision !== "number" ||
          !Number.isInteger(precision) ||
          precision < -15 ||
          precision > 15
        )
          fail(
            args[1],
            "ROUND precision must be an integer literal from -15 to 15",
          );
      } else if (node.name === "CALCULATE") {
        count(2, 32);
        args.slice(1).forEach(validateFilter);
        type = args[0].type;
      } else if (node.name === "ALL") {
        count(1);
        if (args[0].kind !== "column")
          fail(args[0], "ALL expects Table[Column]");
        type = "filter";
      } else if (TIME_FUNCTIONS.has(node.name)) {
        count(node.name === "PREVIOUSPERIOD" ? 2 : 1);
        if (!model.date)
          fail(node, "Time intelligence requires a generated date dimension");
        numeric(args[0]);
        if (node.name === "PREVIOUSPERIOD" && args[1].kind !== "period")
          fail(args[1], "PREVIOUSPERIOD needs MONTH, QUARTER, or YEAR");
      }
      return { kind: "call", name: node.name, args, type, ...span };
    }
    const ast = visit(parse(expression));
    validateScalar(ast);
    return {
      ast,
      type: ast.type,
      dependencies: Object.freeze([...dependencies]),
      cost: expandedNodes,
    };
  }

  function resolveSavedMeasure(
    id: string,
    active: string[],
  ): ResolvedCacheEntry {
    const cached = namespace.get(`measure:${id}`);
    if (cached) return cached;
    const measure = lookup.measuresById.get(id);
    if (!measure)
      throw new ExpressionError(`Unknown measure ${JSON.stringify(id)}`);
    const resolved = resolveSource(measure.expression, [...active, id]);
    namespace.set(`measure:${id}`, resolved);
    return resolved;
  }

  function result(entry: ResolvedCacheEntry): CheckedExpression {
    return {
      ast: entry.ast,
      type: entry.type,
      dependencies: [...entry.dependencies],
    };
  }
  return {
    resolve(expression) {
      const key = `expression:${expression}`;
      let entry = namespace.get(key);
      if (!entry) {
        entry = resolveSource(expression, []);
        namespace.set(key, entry);
      }
      return result(entry);
    },
    resolveMeasure(id) {
      return result(resolveSavedMeasure(id, []));
    },
  };
}

/** Resolve one expression; query compilers should share createExpressionResolver. */
export function resolveExpression(
  expression: string,
  model: SemanticModel,
): CheckedExpression {
  return createExpressionResolver(model).resolve(expression);
}
export const typeCheck = resolveExpression;
