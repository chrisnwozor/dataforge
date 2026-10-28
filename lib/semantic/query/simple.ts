import type { ResolvedExpr } from "../expr";
import type { SemanticColumn, SemanticTable, SqlParameter } from "../types";

interface SimpleBuilder {
  fact: SemanticTable;
  column(ref: { table: SemanticTable; column: SemanticColumn }): string;
  param(value: SqlParameter["value"]): string;
}

const aggregates = new Set(["SUM", "COUNT", "COUNT_BIG", "MIN", "MAX", "AVG"]);
const scalars = new Set(["DIVIDE", "IF", "ABS", "ROUND"]);

/** Context-free expressions can be evaluated by SQL Server's single aggregate operator. */
export function simpleAggregateValues(
  nodes: ResolvedExpr[],
  builder: SimpleBuilder,
  error: (message: string) => Error,
): string[] | null {
  const supported = new WeakMap<ResolvedExpr, boolean>();
  let hasAggregate = false;
  function accepts(node: ResolvedExpr): boolean {
    const cached = supported.get(node);
    if (cached !== undefined) return cached;
    let valid: boolean;
    if (node.kind === "literal") valid = true;
    else if (node.kind === "measure") valid = accepts(node.expression);
    else if (node.kind === "unary") valid = accepts(node.operand);
    else if (node.kind === "binary") valid = accepts(node.left) && accepts(node.right);
    else if (node.kind === "in") valid = accepts(node.expression) && node.values.every(accepts);
    else if (node.kind === "call" && aggregates.has(node.name)) {
      const argument = node.args[0];
      valid = argument?.kind === "column" && argument.table.id === builder.fact.id || argument?.kind === "star" && ["COUNT", "COUNT_BIG"].includes(node.name);
      if (valid) hasAggregate = true;
    } else valid = node.kind === "call" && scalars.has(node.name) && node.args.every(accepts);
    supported.set(node, valid);
    return valid;
  }
  if (!nodes.every(accepts) || !hasAggregate) return null;

  const rendered = new WeakMap<ResolvedExpr, string>();
  const predicateCache = new WeakMap<ResolvedExpr, string>();
  function predicate(node: ResolvedExpr): string {
    const cached = predicateCache.get(node);
    if (cached) return cached;
    let sql: string;
    if (node.kind === "measure") sql = predicate(node.expression);
    else if (node.kind === "unary" && node.op === "NOT") sql = `(NOT ${predicate(node.operand)})`;
    else if (node.kind === "binary" && (node.op === "AND" || node.op === "OR")) sql = `(${predicate(node.left)} ${node.op} ${predicate(node.right)})`;
    else if (node.kind === "binary" && ["=", "!=", "<>", "<", "<=", ">", ">="].includes(node.op)) {
      const left = render(node.left), right = render(node.right);
      const leftNull = node.left.kind === "literal" && node.left.value === null;
      const rightNull = node.right.kind === "literal" && node.right.value === null;
      sql = (leftNull || rightNull) && ["=", "!=", "<>"].includes(node.op)
        ? `(${leftNull ? right : left} IS ${node.op === "=" ? "" : "NOT "}NULL)`
        : `(${left} ${node.op === "!=" ? "<>" : node.op} ${right})`;
    } else if (node.kind === "in") {
      const value = render(node.expression);
      const nonNull = node.values.filter((item) => !(item.kind === "literal" && item.value === null));
      const parts = [nonNull.length ? `${value} ${node.negated ? "NOT " : ""}IN (${nonNull.map(render).join(", ")})` : "", nonNull.length !== node.values.length ? `${value} IS ${node.negated ? "NOT " : ""}NULL` : ""].filter(Boolean);
      sql = `(${parts.join(node.negated ? " AND " : " OR ") || (node.negated ? "1 = 1" : "1 = 0")})`;
    } else sql = `(${render(node)} = CAST(1 AS BIT))`;
    predicateCache.set(node, sql);
    return sql;
  }
  function render(node: ResolvedExpr): string {
    const cached = rendered.get(node);
    if (cached) return cached;
    let sql: string;
    if (node.kind === "literal") sql = node.value === null ? "NULL" : builder.param(node.value);
    else if (node.kind === "measure") sql = render(node.expression);
    else if (node.kind === "unary" && node.op !== "NOT") sql = `(${node.op}${render(node.operand)})`;
    else if (node.kind === "in" || node.kind === "unary" || node.kind === "binary" && !["+", "-", "*", "/", "%"].includes(node.op)) {
      const condition = predicate(node);
      sql = `(CASE WHEN ${condition} THEN CAST(1 AS BIT) WHEN NOT ${condition} THEN CAST(0 AS BIT) ELSE CAST(NULL AS BIT) END)`;
    } else if (node.kind === "binary") {
      const left = render(node.left), right = render(node.right);
      sql = node.op === "/" ? `(CAST(${left} AS FLOAT) / NULLIF(${right}, 0))` : node.op === "%" ? `(${left} % NULLIF(${right}, 0))` : `(${left} ${node.op} ${right})`;
    } else if (node.kind === "call" && aggregates.has(node.name)) {
      const argument = node.args[0];
      const source = argument.kind === "column" ? builder.column(argument) : "*";
      const value = node.name === "SUM" ? `CAST(${source} AS DECIMAL(38, 10))` : node.name === "AVG" ? `CAST(${source} AS FLOAT)` : source;
      sql = `${node.name === "COUNT" ? "COUNT_BIG" : node.name}(${value})`;
    } else if (node.kind === "call" && node.name === "DIVIDE") {
      const numerator = render(node.args[0]), denominator = render(node.args[1]);
      const divided = `(CAST(${numerator} AS FLOAT) / NULLIF(${denominator}, 0))`;
      sql = !node.args[2] || node.args[2].kind === "literal" && node.args[2].value === null ? divided : `(CASE WHEN NULLIF(${denominator}, 0) IS NULL THEN ${render(node.args[2])} ELSE ${divided} END)`;
    } else if (node.kind === "call" && node.name === "IF") sql = `(CASE WHEN ${predicate(node.args[0])} THEN ${render(node.args[1])} ELSE ${render(node.args[2])} END)`;
    else if (node.kind === "call" && (node.name === "ABS" || node.name === "ROUND")) sql = `${node.name}(${node.args.map(render).join(", ")})`;
    else throw error("A simple measure must aggregate fact columns.");
    if (sql.length > 262_144) throw error("The compiled measure is too complex (maximum 256 KiB of SQL).");
    rendered.set(node, sql);
    return sql;
  }
  return nodes.map(render);
}
