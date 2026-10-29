import { tokenize } from "@/lib/semantic/expr/tokenizer";
import { ExpressionError } from "@/lib/semantic/expr/types";
import { addCalendarDate, calendarDateParts, convertCell } from "./conversion";
import type { Cell, PrepareRow } from "./schema";

export { ExpressionError as RowExpressionError };
type Node = { kind: "literal"; value: Cell; pos: number; end: number } | { kind: "reference"; column: string; pos: number; end: number } | { kind: "unary"; op: string; operand: Node; pos: number; end: number } | { kind: "binary"; op: string; left: Node; right: Node; pos: number; end: number } | { kind: "call"; name: string; args: Node[]; pos: number; end: number };
type ValueType = "number" | "text" | "boolean" | "null" | "unknown";
interface Compiled { type: ValueType; evaluate(row: PrepareRow): Cell }
export interface RowExpression { (row: PrepareRow): Cell; readonly referencedColumns: readonly string[] }
const precedence: Record<string, number> = { OR: 1, AND: 2, "=": 3, "!=": 3, "<>": 3, "<": 3, "<=": 3, ">": 3, ">=": 3, "+": 4, "-": 4, "*": 5, "/": 5, "%": 5 };
const units = new Set(["YEAR", "QUARTER", "MONTH", "WEEK", "DAY"]);
const signatures: Record<string, [number, number]> = { IF: [3, 3], COALESCE: [1, 32], CONCAT: [1, 32], UPPER: [1, 1], LOWER: [1, 1], TRIM: [1, 1], LEFT: [2, 2], RIGHT: [2, 2], SUBSTRING: [3, 3], LEN: [1, 1], REPLACE: [3, 3], ROUND: [1, 2], ABS: [1, 1], TONUMBER: [1, 1], TODATE: [1, 2], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], DATEADD: [3, 3], DATEDIFF: [3, 3] };

/** Reuse the semantic tokenizer, with a small row-only grammar and no model/SQL compilation. */
function parseRowExpression(expression: string): Node {
  const tokens = tokenize(expression); let cursor = 0, nesting = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const is = (value: string) => ["punctuation", "operator", "identifier"].includes(peek().kind) && peek().value.toUpperCase() === value;
  const expect = (value: string) => { if (!is(value)) throw new ExpressionError(`Expected ${value}`, peek().pos, peek().end); return take(); };
  function nested<T>(operation: () => T): T { if (++nesting > 12) throw new ExpressionError("Expressions may nest at most 12 levels", peek().pos); try { return operation(); } finally { nesting--; } }
  function primary(): Node {
    const token = take();
    if (token.kind === "number") return { kind: "literal", value: Number(token.value), pos: token.pos, end: token.end };
    if (token.kind === "string") return { kind: "literal", value: token.value, pos: token.pos, end: token.end };
    if (token.kind === "reference") return { kind: "reference", column: token.value, pos: token.pos, end: token.end };
    if (token.value === "(") return nested(() => { const value = binary(0); expect(")"); return value; });
    if (token.kind === "identifier") {
      const name = token.value.toUpperCase();
      if (is("(")) return nested(() => {
        take(); const args: Node[] = [];
        if (!is(")")) { args.push(binary(0)); while (is(",")) { take(); if (args.length >= 32) throw new ExpressionError("Functions accept at most 32 arguments", token.pos); args.push(binary(0)); } }
        const close = expect(")"); return { kind: "call", name, args, pos: token.pos, end: close.end };
      });
      if (["TRUE", "FALSE", "NULL"].includes(name)) return { kind: "literal", value: name === "NULL" ? null : name === "TRUE", pos: token.pos, end: token.end };
      if (units.has(name)) return { kind: "literal", value: name, pos: token.pos, end: token.end };
    }
    throw new ExpressionError("Expected a value, [Column Name], or supported function", token.pos, token.end);
  }
  function unary(): Node {
    if (is("+") || is("-") || is("NOT")) return nested(() => { const token = take(), operand = unary(); return { kind: "unary", op: token.value.toUpperCase(), operand, pos: token.pos, end: operand.end }; });
    return primary();
  }
  function binary(minimum: number): Node {
    let left = unary();
    while (["operator", "identifier"].includes(peek().kind)) {
      const token = peek(), op = token.value.toUpperCase(), rank = precedence[op];
      if (rank === undefined || rank < minimum) break;
      take(); const right = binary(rank + 1); left = { kind: "binary", op, left, right, pos: left.pos, end: right.end };
    }
    return left;
  }
  const result = binary(0);
  if (peek().kind !== "eof") throw new ExpressionError("Unexpected expression input", peek().pos, peek().end);
  return result;
}
const typeOf = (value: Cell): ValueType => value === null ? "null" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text";
const text = (value: Cell) => value === null ? null : String(value);
const number = (value: Cell): number | null => convertCell(value, "decimal") as number | null;
const truth = (value: Cell): boolean | null => convertCell(value, "boolean") as boolean | null;
function integer(value: Cell, name: string, minimum = 0): number {
  const result = convertCell(value, "integer");
  if (typeof result !== "number" || result < minimum || result > 1_000_000) throw new Error(`${name} must be an integer between ${minimum} and 1,000,000.`);
  return result;
}
function comparable(left: Cell, right: Cell): [string | number | boolean, string | number | boolean] | null {
  if (left === null || right === null) return null;
  if (typeof left === "number" || typeof right === "number") { const a = number(left), b = number(right); return a === null || b === null ? null : [a, b]; }
  if (typeof left === "boolean" || typeof right === "boolean") { const a = truth(left), b = truth(right); return a === null || b === null ? null : [a, b]; }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(left) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(right)) { const a = number(left), b = number(right); return a === null || b === null ? null : [a, b]; }
  return [left, right];
}
function finite(value: number): number { if (!Number.isFinite(value)) throw new Error("The numeric result is outside the supported finite range."); return value === 0 ? 0 : value; }
function boundedText(value: string): string { if (value.length > 1_048_576) throw new Error("A derived text value exceeds the 1 MB cell limit."); return value; }
function concatenate(values: readonly Cell[]): string {
  let length = 0; const chunks: string[] = [];
  for (const value of values) { const chunk = String(value ?? ""); length += chunk.length; if (length > 1_048_576) throw new Error("A derived text value exceeds the 1 MB cell limit."); chunks.push(chunk); }
  return chunks.join("");
}
function replaceText(input: string, find: string, replacement: string): string {
  if (!find) return input;
  const chunks: string[] = []; let cursor = 0, length = 0, next: number;
  const append = (chunk: string) => { length += chunk.length; if (length > 1_048_576) throw new Error("A derived text value exceeds the 1 MB cell limit."); chunks.push(chunk); };
  while ((next = input.indexOf(find, cursor)) >= 0) { append(input.slice(cursor, next)); append(replacement); cursor = next + find.length; }
  append(input.slice(cursor)); return chunks.join("");
}

/** Compile once to closed, row-only functions; user text is never evaluated as JavaScript. */
export function compileRowExpression(expression: string, columns: readonly string[]): RowExpression {
  const node = parseRowExpression(expression), references = new Set<string>();
  function issue(node: Node, message: string): never { throw new ExpressionError(message, node.pos, node.end); }
  function requireType(node: Node, value: Compiled | undefined, expected: ValueType, label: string) { if (value && value.type !== "unknown" && value.type !== "null" && value.type !== expected) issue(node, `${label} requires ${expected === "text" ? "text" : expected} input`); }
  function compile(node: Node): Compiled {
    if (node.kind === "literal") return { type: typeOf(node.value), evaluate: () => node.value };
    if (node.kind === "reference") {
      const exact = columns.find((column) => column === node.column);
      const matches = exact ? [exact] : columns.filter((column) => column.toLowerCase() === node.column.toLowerCase());
      if (matches.length !== 1) issue(node, `Unknown or ambiguous column [${node.column}]`);
      const column = matches[0]; references.add(column);
      return { type: "unknown", evaluate: (row) => Object.hasOwn(row, column) ? row[column] ?? null : null };
    }
    if (node.kind === "unary") {
      const operand = compile(node.operand); requireType(node, operand, node.op === "NOT" ? "boolean" : "number", node.op);
      return { type: node.op === "NOT" ? "boolean" : "number", evaluate: (row) => { const value = operand.evaluate(row); if (value === null) return null; const converted = node.op === "NOT" ? truth(value) : number(value); if (converted === null) return null; return node.op === "NOT" ? !converted : finite((node.op === "-" ? -1 : 1) * (converted as number)); } };
    }
    if (node.kind === "binary") {
      const left = compile(node.left), right = compile(node.right);
      const logical = node.op === "AND" || node.op === "OR", arithmetic = ["+", "-", "*", "/", "%"].includes(node.op);
      if (logical || arithmetic) { requireType(node.left, left, logical ? "boolean" : "number", node.op); requireType(node.right, right, logical ? "boolean" : "number", node.op); }
      return { type: arithmetic ? "number" : "boolean", evaluate: (row) => {
        const a = left.evaluate(row);
        if (logical) {
          const first = truth(a); if (node.op === "AND" && first === false) return false; if (node.op === "OR" && first === true) return true;
          const second = truth(right.evaluate(row));
          return node.op === "AND" ? second === false ? false : first === null || second === null ? null : true : second === true ? true : first === null || second === null ? null : false;
        }
        const b = right.evaluate(row); if (a === null || b === null) return null;
        if (arithmetic) {
          const first = number(a), second = number(b); if (first === null || second === null || (node.op === "/" || node.op === "%") && second === 0) return null;
          return finite(node.op === "+" ? first + second : node.op === "-" ? first - second : node.op === "*" ? first * second : node.op === "/" ? first / second : first % second);
        }
        const values = comparable(a, b); if (!values) return null; const [first, second] = values;
        return node.op === "=" ? first === second : node.op === "!=" || node.op === "<>" ? first !== second : node.op === ">" ? first > second : node.op === ">=" ? first >= second : node.op === "<" ? first < second : first <= second;
      } };
    }
    const signature = signatures[node.name];
    if (!signature) issue(node, `Unsupported function ${node.name}`);
    if (node.args.length < signature[0] || node.args.length > signature[1]) issue(node, `${node.name} requires ${signature[0] === signature[1] ? signature[0] : `${signature[0]}–${signature[1]}`} arguments`);
    const args = node.args.map(compile);
    if (["UPPER", "LOWER", "TRIM", "LEFT", "RIGHT", "SUBSTRING", "LEN", "REPLACE", "TODATE", "YEAR", "MONTH", "DAY"].includes(node.name)) requireType(node.args[0], args[0], "text", node.name);
    if (["ABS", "ROUND"].includes(node.name)) requireType(node.args[0], args[0], "number", node.name);
    if (node.name === "IF") requireType(node.args[0], args[0], "boolean", "IF condition");
    if (node.name === "REPLACE") { requireType(node.args[1], args[1], "text", node.name); requireType(node.args[2], args[2], "text", node.name); }
    if (node.name === "TODATE" && args[1]) requireType(node.args[1], args[1], "text", "Date pattern");
    if (["LEFT", "RIGHT", "SUBSTRING", "ROUND"].includes(node.name)) for (let index = 1; index < args.length; index++) requireType(node.args[index], args[index], "number", node.name);
    if (["DATEADD", "DATEDIFF"].includes(node.name)) {
      if (node.args[0].kind !== "literal" || typeof node.args[0].value !== "string" || !units.has(node.args[0].value.toUpperCase())) issue(node.args[0], "Choose a literal date unit YEAR, QUARTER, MONTH, WEEK, or DAY");
      if (node.name === "DATEADD") requireType(node.args[1], args[1], "number", node.name);
      requireType(node.args[2], args[2], "text", node.name);
      if (node.name === "DATEDIFF") requireType(node.args[1], args[1], "text", node.name);
    }
    const valueType: ValueType = ["LEN", "ROUND", "ABS", "TONUMBER", "YEAR", "MONTH", "DAY", "DATEDIFF"].includes(node.name) ? "number" : node.name === "IF" ? args[1].type === args[2].type ? args[1].type : "unknown" : node.name === "COALESCE" ? "unknown" : "text";
    return { type: valueType, evaluate: (row) => {
      if (node.name === "IF") return args[truth(args[0].evaluate(row)) ? 1 : 2].evaluate(row);
      if (node.name === "COALESCE") { for (const argument of args) { const value = argument.evaluate(row); if (value !== null) return value; } return null; }
      const values = args.map((argument) => argument.evaluate(row));
      if (node.name === "CONCAT") return concatenate(values);
      if (values.some((value) => value === null)) return null;
      const first = text(values[0])!;
      switch (node.name) {
        case "UPPER": return boundedText(first.toUpperCase());
        case "LOWER": return first.toLowerCase();
        case "TRIM": return first.trim();
        case "LEFT": return first.slice(0, integer(values[1], "Length"));
        case "RIGHT": { const count = integer(values[1], "Length"); return count ? first.slice(-count) : ""; }
        case "SUBSTRING": { const start = integer(values[1], "Start", 1) - 1; return first.slice(start, start + integer(values[2], "Length")); }
        case "LEN": return first.length;
        case "REPLACE": return replaceText(first, String(values[1]), String(values[2]));
        case "TONUMBER": return convertCell(values[0], "decimal");
        case "TODATE": return convertCell(values[0], "date", values[1] === undefined ? undefined : String(values[1]));
        case "ABS": { const value = number(values[0]); return value === null ? null : Math.abs(value); }
        case "ROUND": { const value = number(values[0]); if (value === null) return null; const digits = values[1] === undefined ? 0 : convertCell(values[1], "integer"); if (typeof digits !== "number" || digits < -10 || digits > 10) throw new Error("ROUND decimal places must be between -10 and 10."); const scale = 10 ** digits, scaled = Math.abs(value) * scale; return finite(Math.sign(value) * Math.round(scaled + Number.EPSILON * Math.max(1, scaled)) / scale); }
        case "YEAR": case "MONTH": case "DAY": { const converted = convertCell(values[0], "date"); if (converted === null) return null; return calendarDateParts(converted as string)[node.name === "YEAR" ? 0 : node.name === "MONTH" ? 1 : 2]; }
        case "DATEADD": { const date = convertCell(values[2], "date"), amount = convertCell(values[1], "integer"); if (date === null || amount === null) return null; return addCalendarDate(date as string, first.toUpperCase() as Parameters<typeof addCalendarDate>[1], amount as number); }
        case "DATEDIFF": {
          const start = convertCell(values[1], "date"), end = convertCell(values[2], "date"); if (start === null || end === null) return null; const a = calendarDateParts(start as string), b = calendarDateParts(end as string);
          if (first.toUpperCase() === "YEAR") return b[0] - a[0];
          if (first.toUpperCase() === "MONTH") return (b[0] - a[0]) * 12 + b[1] - a[1];
          if (first.toUpperCase() === "QUARTER") return (b[0] - a[0]) * 4 + Math.floor((b[1] - 1) / 3) - Math.floor((a[1] - 1) / 3);
          const epoch = (parts: [number, number, number]) => { const date = new Date(0); date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]); date.setUTCHours(0, 0, 0, 0); return date.getTime(); };
          return Math.trunc((epoch(b) - epoch(a)) / (first.toUpperCase() === "WEEK" ? 604_800_000 : 86_400_000));
        }
        default: return null;
      }
    } };
  }
  const compiled = compile(node);
  const evaluate = ((row: PrepareRow) => { try { const result = compiled.evaluate(row); return typeof result === "string" ? boundedText(result) : typeof result === "number" ? finite(result) : result; } catch (error) { if (error instanceof ExpressionError) throw error; throw new ExpressionError(error instanceof Error ? error.message : "The expression could not be evaluated", node.pos, node.end); } }) as RowExpression;
  Object.defineProperty(evaluate, "referencedColumns", { value: Object.freeze([...references]), enumerable: true });
  return evaluate;
}
