import { ExpressionError } from "./types";

export interface Token {
  kind:
    | "number"
    | "string"
    | "identifier"
    | "reference"
    | "operator"
    | "punctuation"
    | "eof";
  value: string;
  pos: number;
  end: number;
}

export function tokenize(expression: string): Token[] {
  if (typeof expression !== "string" || expression.length > 2_000)
    throw new ExpressionError(
      "Expressions must contain at most 2,000 characters",
      0,
    );
  if (!expression.trim()) throw new ExpressionError("Enter an expression", 0);
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expression.length) {
    const start = pos;
    const char = expression[pos];
    if (/\s/.test(char)) {
      pos++;
      continue;
    }
    if (char === "'" || char === "[") {
      const close = char === "'" ? "'" : "]";
      pos++;
      let value = "";
      let ended = false;
      while (pos < expression.length) {
        if (expression[pos] === close) {
          if (expression[pos + 1] === close) {
            value += close;
            pos += 2;
          } else {
            pos++;
            ended = true;
            break;
          }
        } else value += expression[pos++];
      }
      if (!ended)
        throw new ExpressionError(
          char === "'" ? "Unterminated string" : "Unterminated reference",
          start,
          pos,
        );
      tokens.push({
        kind: char === "'" ? "string" : "reference",
        value,
        pos: start,
        end: pos,
      });
      continue;
    }
    if (
      /\d/.test(char) ||
      (char === "." && /\d/.test(expression[pos + 1] ?? ""))
    ) {
      const match = expression
        .slice(pos)
        .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)![0];
      pos += match.length;
      if (!Number.isFinite(Number(match)))
        throw new ExpressionError(
          "Number is outside the supported range",
          start,
          pos,
        );
      tokens.push({ kind: "number", value: match, pos: start, end: pos });
      continue;
    }
    if (/[\p{L}_]/u.test(char)) {
      pos++;
      while (pos < expression.length && /[\p{L}\p{N}_]/u.test(expression[pos]))
        pos++;
      tokens.push({
        kind: "identifier",
        value: expression.slice(start, pos),
        pos: start,
        end: pos,
      });
      continue;
    }
    if (
      char === ";" ||
      expression.slice(pos, pos + 2) === "--" ||
      expression.slice(pos, pos + 2) === "/*"
    )
      throw new ExpressionError(
        "SQL statements and comments are not expression syntax",
        start,
      );
    const pair = expression.slice(pos, pos + 2);
    if (["<=", ">=", "<>", "!="].includes(pair)) {
      tokens.push({ kind: "operator", value: pair, pos, end: pos + 2 });
      pos += 2;
      continue;
    }
    if ("+-*/%=<>".includes(char)) {
      tokens.push({ kind: "operator", value: char, pos, end: pos + 1 });
      pos++;
      continue;
    }
    if ("(),".includes(char)) {
      tokens.push({ kind: "punctuation", value: char, pos, end: pos + 1 });
      pos++;
      continue;
    }
    throw new ExpressionError(
      `Unexpected character ${JSON.stringify(char)}`,
      start,
    );
  }
  tokens.push({ kind: "eof", value: "", pos, end: pos });
  return tokens;
}
