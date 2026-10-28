import { tokenize, type Token } from "./tokenizer";
import {
  ExpressionError,
  type BinaryOperator,
  type Expr,
  type Period,
} from "./types";

const precedence: Record<string, number> = {
  OR: 1,
  AND: 2,
  "=": 3,
  "<>": 3,
  "!=": 3,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  IN: 3,
  "+": 4,
  "-": 4,
  "*": 5,
  "/": 5,
  "%": 5,
};
export function parse(expression: string): Expr {
  const tokens = tokenize(expression);
  let cursor = 0;
  let nesting = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const is = (value: string) => {
    const token = peek();
    return (
      ["punctuation", "operator", "identifier"].includes(token.kind) &&
      token.value.toUpperCase() === value
    );
  };
  const expect = (value: string) => {
    const token = peek();
    if (!is(value))
      throw new ExpressionError(`Expected ${value}`, token.pos, token.end);
    return take();
  };
  const nested = <T>(fn: () => T): T => {
    nesting++;
    if (nesting > 12)
      throw new ExpressionError(
        "Expressions may nest at most 12 levels",
        peek().pos,
      );
    try {
      return fn();
    } finally {
      nesting--;
    }
  };
  function primary(): Expr {
    const token = take();
    const span = { pos: token.pos, end: token.end };
    if (token.kind === "number")
      return { kind: "literal", value: Number(token.value), ...span };
    if (token.kind === "string") {
      if (peek().kind === "reference") {
        const column = take();
        return {
          kind: "column",
          tableName: token.value,
          columnName: column.value,
          pos: token.pos,
          end: column.end,
        };
      }
      return { kind: "literal", value: token.value, ...span };
    }
    if (token.kind === "reference")
      return { kind: "measure", name: token.value, ...span };
    if (token.value === "(")
      return nested(() => {
        const inner = binary(0);
        expect(")");
        return inner;
      });
    if (token.value === "*") return { kind: "star", ...span };
    if (token.kind === "identifier") {
      const upper = token.value.toUpperCase();
      if (peek().kind === "reference") {
        const column = take();
        return {
          kind: "column",
          tableName: token.value,
          columnName: column.value,
          pos: token.pos,
          end: column.end,
        };
      }
      if (upper === "TRUE" || upper === "FALSE" || upper === "NULL")
        return {
          kind: "literal",
          value: upper === "NULL" ? null : upper === "TRUE",
          ...span,
        };
      if (["MONTH", "QUARTER", "YEAR"].includes(upper))
        return { kind: "period", value: upper as Period, ...span };
      if (is("("))
        return nested(() => {
          take();
          const args: Expr[] = [];
          if (!is(")")) {
            args.push(binary(0));
            while (is(",")) {
              take();
              args.push(binary(0));
            }
          }
          const close = expect(")");
          return {
            kind: "call",
            name: upper,
            args,
            pos: token.pos,
            end: close.end,
          };
        });
      throw new ExpressionError(
        "Expected a function or Table[Column] reference",
        token.pos,
        token.end,
      );
    }
    throw new ExpressionError(
      "Expected a value, reference, or function",
      token.pos,
      token.end,
    );
  }
  function unary(): Expr {
    if (is("NOT") || is("+") || is("-"))
      return nested(() => {
        const token = take();
        const operand =
          token.value.toUpperCase() === "NOT" ? binary(3) : unary();
        return {
          kind: "unary",
          op: token.value.toUpperCase() as "+" | "-" | "NOT",
          operand,
          pos: token.pos,
          end: operand.end,
        };
      });
    return primary();
  }
  function binary(minimum: number): Expr {
    let left = unary();
    while (true) {
      const current = peek();
      if (current.kind !== "identifier" && current.kind !== "operator") break;
      let op = current.value.toUpperCase();
      const notIn =
        op === "NOT" &&
        tokens[cursor + 1]?.kind === "identifier" &&
        tokens[cursor + 1]?.value.toUpperCase() === "IN";
      if (notIn) op = "IN";
      const rank = precedence[op];
      if (rank === undefined || rank < minimum) break;
      take();
      if (notIn) take();
      if (op === "IN") {
        const values = nested(() => {
          expect("(");
          const items: Expr[] = [];
          if (!is(")")) {
            items.push(binary(0));
            while (is(",")) {
              take();
              items.push(binary(0));
            }
          }
          expect(")");
          return items;
        });
        if (!values.length)
          throw new ExpressionError("IN needs at least one value", current.pos);
        left = {
          kind: "in",
          expression: left,
          values,
          negated: notIn,
          pos: left.pos,
          end: tokens[cursor - 1].end,
        };
      } else {
        const right = binary(rank + 1);
        left = {
          kind: "binary",
          op: op as BinaryOperator,
          left,
          right,
          pos: left.pos,
          end: right.end,
        };
      }
    }
    return left;
  }
  const ast = binary(0);
  if (peek().kind !== "eof") {
    const extra: Token = peek();
    throw new ExpressionError(
      `Unexpected token ${extra.value}`,
      extra.pos,
      extra.end,
    );
  }
  return ast;
}
export const parseExpression = parse;
