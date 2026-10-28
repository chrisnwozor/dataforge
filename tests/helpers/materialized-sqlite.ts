import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { CompiledQuery } from "@/lib/semantic/query/types";

/**
 * Execute the compiler's relational SQL, not a separate implementation of its
 * measure rules. Only SQL Server DDL/date syntax is adapted for this local
 * oracle. SQL Server planning, tempdb indexes, TDS and latency are not tested.
 */
interface Token {
  text: string;
  start: number;
  end: number;
  depth: number;
}
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0,
    depth = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("Unclosed SQL comment in oracle input.");
      i = end + 2;
      continue;
    }
    const start = i;
    const close =
      sql[i] === "["
        ? "]"
        : sql[i] === "'"
          ? "'"
          : sql[i] === '"'
            ? '"'
            : undefined;
    if (close) {
      i++;
      while (i < sql.length) {
        if (sql[i++] === close) {
          if (sql[i] === close) i++;
          else break;
        }
      }
    } else if (/[\w@#]/.test(sql[i])) {
      while (i < sql.length && /[\w@#]/.test(sql[i])) i++;
    } else i++;
    if (sql.slice(start, i) === ")") depth--;
    result.push({ text: sql.slice(start, i), start, end: i, depth });
    if (sql.slice(start, i) === "(") depth++;
  }
  return result;
}

function splitStatements(sql: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const token of tokens(sql))
    if (token.text === ";" && token.depth === 0) {
      if (sql.slice(start, token.start).trim())
        result.push(sql.slice(start, token.start).trim());
      start = token.end;
    }
  if (sql.slice(start).trim()) result.push(sql.slice(start).trim());
  return result;
}
function splitList(sql: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const token of tokens(sql))
    if (token.text === "," && token.depth === 0) {
      result.push(sql.slice(start, token.start).trim());
      start = token.end;
    }
  result.push(sql.slice(start).trim());
  return result;
}
const canonical = (sql: string) => sql.replace(/\s/g, "").toLowerCase();

function happyPath(sql: string): string {
  // Catch branches clean up and rethrow; executing them after a successful
  // SELECT would test a different control path. The happy branch keeps every
  // actual relational statement and final DROP from the generated batch.
  const start = /\bBEGIN\s+TRY\b/i.exec(sql);
  if (!start) return sql;
  const end = /\bEND\s+TRY\b/i.exec(sql.slice(start.index + start[0].length));
  if (!end) throw new Error("Missing END TRY in generated query.");
  return (
    sql.slice(0, start.index) +
    sql.slice(
      start.index + start[0].length,
      start.index + start[0].length + end.index,
    )
  );
}

function selectInto(statement: string): { sql: string; destination?: string } {
  const parts = tokens(statement);
  const into = parts.findIndex(
    (token) => token.depth === 0 && token.text.toUpperCase() === "INTO",
  );
  if (into < 0) return { sql: statement };
  const target = parts[into + 1];
  if (!target || !/^\[?#df_[\w]+\]?$/i.test(target.text))
    throw new Error("Unexpected SELECT INTO target in relational oracle.");
  return {
    sql: statement.slice(0, parts[into].start) + statement.slice(target.end),
    destination: target.text,
  };
}

/** GROUPING SETS is exactly UNION ALL over its grouping grains in SQLite. */
function groupingSets(statement: string): string {
  const parts = tokens(statement);
  const groupIndex = parts.findIndex(
    (token, index) =>
      token.depth === 0 &&
      token.text.toUpperCase() === "GROUP" &&
      parts[index + 1]?.text.toUpperCase() === "BY" &&
      parts[index + 2]?.text.toUpperCase() === "GROUPING" &&
      parts[index + 3]?.text.toUpperCase() === "SETS",
  );
  if (groupIndex < 0) return statement;
  const open = parts[groupIndex + 4];
  if (open?.text !== "(") throw new Error("Unexpected GROUPING SETS shape.");
  const close = parts
    .slice(groupIndex + 5)
    .find((token) => token.text === ")" && token.depth === 0);
  if (!close) throw new Error("Unclosed GROUPING SETS.");
  const grains = splitList(statement.slice(open.end, close.start)).map(
    (grain) => {
      if (!grain.startsWith("(") || !grain.endsWith(")"))
        throw new Error("Grouping grain must use parentheses.");
      const body = grain.slice(1, -1).trim();
      return body ? splitList(body) : [];
    },
  );
  const select = parts.find(
    (token) => token.depth === 0 && token.text.toUpperCase() === "SELECT",
  );
  const from = parts.find(
    (token) => token.depth === 0 && token.text.toUpperCase() === "FROM",
  );
  if (!select || !from)
    throw new Error("GROUPING SETS requires a SELECT/FROM.");
  const projection = statement.slice(select.end, from.start);
  const groupingArguments = /\bGROUPING_ID\s*\(([^)]*)\)/i.exec(projection);
  // Ungrouped queries have no GROUPING_ID arguments: the sole grain is ().
  const allKeys = groupingArguments
    ? splitList(groupingArguments[1])
    : [...new Set(grains.flat())];
  const tail = statement.slice(close.end);
  return grains
    .map((grain) => {
      const kept = new Set(grain.map(canonical));
      const mask = allKeys.reduce(
        (value, key, index) =>
          value +
          (kept.has(canonical(key)) ? 0 : 2 ** (allKeys.length - 1 - index)),
        0,
      );
      const columns = splitList(projection).map((item) => {
        const fields = tokens(item);
        const alias = fields.find(
          (token) => token.depth === 0 && token.text.toUpperCase() === "AS",
        );
        const expression = alias
          ? item.slice(0, alias.start).trim()
          : item.trim();
        const key = allKeys.find(
          (key) => canonical(key) === canonical(expression),
        );
        if (key && !kept.has(canonical(key)))
          return `NULL ${alias ? item.slice(alias.start) : `AS ${fields.at(-1)!.text}`}`;
        return item.replace(/\bGROUPING_ID\s*\([^)]*\)/gi, String(mask));
      });
      return `SELECT ${columns.join(", ")} ${statement.slice(from.start, parts[groupIndex].start)}${grain.length ? ` GROUP BY ${grain.join(", ")}` : ""}${tail.replace(/\bGROUPING_ID\s*\([^)]*\)/gi, String(mask))}`;
    })
    .join("\nUNION ALL\n");
}

/**
 * SQLite has no APPLY. A one-row VALUES of pure scalar expressions is exactly
 * scalar substitution; no filtering, aggregation, or grouping is changed.
 */
function inlineScalarValues(statement: string): string {
  let sql = statement;
  while (true) {
    const parts = tokens(sql);
    const start = parts.findIndex(
      (token, index) =>
        token.depth === 0 &&
        token.text.toUpperCase() === "CROSS" &&
        parts[index + 1]?.text.toUpperCase() === "APPLY",
    );
    if (start < 0) return sql;
    if (
      parts[start + 2]?.text !== "(" ||
      parts[start + 3]?.text.toUpperCase() !== "VALUES" ||
      parts[start + 4]?.text !== "("
    )
      throw new Error("The oracle supports only scalar CROSS APPLY VALUES.");
    const expressionStart = parts[start + 4].end;
    const tupleEnd = parts.findIndex(
      (token, index) =>
        index > start + 4 && token.text === ")" && token.depth === 1,
    );
    if (
      tupleEnd < 0 ||
      parts[tupleEnd + 1]?.text !== ")" ||
      parts[tupleEnd + 2]?.text.toUpperCase() !== "AS" ||
      parts[tupleEnd + 4]?.text !== "(" ||
      parts[tupleEnd + 6]?.text !== ")"
    )
      throw new Error("Unexpected scalar APPLY alias shape.");
    const expression = sql.slice(expressionStart, parts[tupleEnd].start);
    const alias = parts[tupleEnd + 3].text;
    const column = parts[tupleEnd + 5].text;
    const escaped = (value: string) =>
      value.replaceAll("[", "\\[").replaceAll("]", "\\]");
    const reference = new RegExp(
      `${escaped(alias)}\\s*\\.\\s*${escaped(column)}`,
      "g",
    );
    sql = (
      sql.slice(0, parts[start].start) + sql.slice(parts[tupleEnd + 6].end)
    ).replace(reference, () => `(${expression})`);
  }
}

function parsedDate(value: SQLInputValue | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(
    String(value).includes("T")
      ? String(value)
      : `${String(value).slice(0, 10)}T00:00:00.000Z`,
  );
  return Number.isFinite(date.getTime()) ? date : null;
}
const iso = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
function dateParts(year: number, month: number, day: number): Date {
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year, month - 1, day);
  return result;
}
function dateAdd(
  unit: string,
  amount: number,
  value: SQLInputValue,
): string | null {
  const date = parsedDate(value);
  if (!date) return null;
  const part = unit.toUpperCase();
  if (
    ["YEAR", "YY", "YYYY", "QUARTER", "QQ", "Q", "MONTH", "MM", "M"].includes(
      part,
    )
  ) {
    const months = ["YEAR", "YY", "YYYY"].includes(part)
      ? amount * 12
      : ["QUARTER", "QQ", "Q"].includes(part)
        ? amount * 3
        : amount;
    const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
    const year = Math.floor(target / 12),
      month = ((target % 12) + 12) % 12;
    const last = dateParts(year, month + 2, 0).getUTCDate();
    return iso(dateParts(year, month + 1, Math.min(date.getUTCDate(), last)));
  }
  if (!["DAY", "DD", "D", "WEEK", "WK", "WW"].includes(part))
    throw new Error(`Unsupported dateadd in oracle: ${unit}`);
  date.setUTCDate(
    date.getUTCDate() + amount * (["WEEK", "WK", "WW"].includes(part) ? 7 : 1),
  );
  return iso(date);
}
export function registerSqlServerDateFunctions(db: DatabaseSync): void {
  for (const [name, read] of [
    ["YEAR", (date: Date) => date.getUTCFullYear()],
    ["MONTH", (date: Date) => date.getUTCMonth() + 1],
    ["DAY", (date: Date) => date.getUTCDate()],
  ] as const)
    db.function(name, { deterministic: true }, (value) => {
      const date = parsedDate(value);
      return date ? read(date) : null;
    });
  db.function("DATEFROMPARTS", { deterministic: true }, (year, month, day) =>
    year === null || month === null || day === null
      ? null
      : iso(dateParts(Number(year), Number(month), Number(day))),
  );
  db.function("DATEADD", { deterministic: true }, (unit, amount, value) =>
    unit === null || amount === null
      ? null
      : dateAdd(String(unit), Number(amount), value),
  );
  db.function("DATEPART", { deterministic: true }, (unit, value) => {
    const date = parsedDate(value);
    if (!date || unit === null) return null;
    switch (String(unit).toUpperCase()) {
      case "YEAR":
        return date.getUTCFullYear();
      case "QUARTER":
        return Math.floor(date.getUTCMonth() / 3) + 1;
      case "MONTH":
        return date.getUTCMonth() + 1;
      case "DAY":
        return date.getUTCDate();
      default:
        throw new Error(`Unsupported datepart in oracle: ${String(unit)}`);
    }
  });
  db.function("DATEDIFF", { deterministic: true }, (unit, first, last) => {
    const a = parsedDate(first),
      b = parsedDate(last);
    if (!a || !b || unit === null) return null;
    switch (String(unit).toUpperCase()) {
      case "YEAR":
        return b.getUTCFullYear() - a.getUTCFullYear();
      case "QUARTER":
        return (
          (b.getUTCFullYear() - a.getUTCFullYear()) * 4 +
          Math.floor(b.getUTCMonth() / 3) -
          Math.floor(a.getUTCMonth() / 3)
        );
      case "MONTH":
        return (
          (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
          b.getUTCMonth() -
          a.getUTCMonth()
        );
      case "DAY":
        return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
      default:
        throw new Error(`Unsupported datediff in oracle: ${String(unit)}`);
    }
  });
  db.function(
    "EOMONTH",
    { deterministic: true, varargs: true },
    (...values) => {
      const date = parsedDate(values[0]);
      if (!date) return null;
      return iso(
        dateParts(
          date.getUTCFullYear(),
          date.getUTCMonth() + 2 + Number(values[1] ?? 0),
          0,
        ),
      );
    },
  );
}

function dialect(statement: string): string | undefined {
  const first = tokens(statement)[0]?.text.toUpperCase();
  if (
    !first ||
    first === "SET" ||
    /^CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\b/i.test(
      statement,
    )
  )
    return undefined;
  const selected = selectInto(inlineScalarValues(statement));
  let sql = selected.sql;
  const destination = selected.destination;
  sql = groupingSets(sql)
    .replace(/\bCOUNT_BIG\s*\(/gi, "COUNT(")
    .replace(/\bISNULL\s*\(/gi, "COALESCE(")
    .replace(
      /\b(DATEADD|DATEDIFF|DATEPART)\s*\(\s*(YEAR|QUARTER|MONTH|DAY|WEEK|YYYY|YY|QQ|Q|MM|M|DD|D|WK|WW)\s*,/gi,
      "$1('$2',",
    )
    .replace(/\bN(?=')/g, "");
  let limit: string | undefined;
  sql = sql.replace(
    /\bSELECT\s+TOP\s*\(\s*(@[\w]+|\d+)\s*\)/i,
    (_all, count: string) => {
      limit = count;
      return "SELECT";
    },
  );
  if (limit) sql += ` LIMIT ${limit}`;
  if (destination) sql = `CREATE TEMP TABLE ${destination} AS ${sql}`;
  // SQLite names local temporary tables explicitly; SQL Server may omit brackets.
  sql = sql.replace(/(?<![\w\[])#df_[\w]+(?![\w\]])/g, (name) => `[${name}]`);
  return sql;
}

export function executeMaterializedSqlite(
  db: DatabaseSync,
  compiled: CompiledQuery,
): Record<string, unknown>[] {
  registerSqlServerDateFunctions(db);
  const params = Object.fromEntries(
    compiled.params.map((parameter) => [
      `@${parameter.name}`,
      typeof parameter.value === "boolean"
        ? Number(parameter.value)
        : parameter.value,
    ]),
  );
  let rows: Record<string, unknown>[] = [];
  for (const statement of splitStatements(happyPath(compiled.sql))) {
    const sql = dialect(statement);
    if (!sql) continue;
    try {
      const prepared = db.prepare(sql);
      // This avoids setAllowUnknownNamedParameters, unavailable in Node 22.13.
      const names = new Set(
        tokens(sql)
          .filter((token) => /^@[\w]+$/.test(token.text))
          .map((token) => token.text),
      );
      const bindings = Object.fromEntries(
        Object.entries(params).filter(([name]) => names.has(name)),
      );
      if (/^(?:SELECT|WITH)\b/i.test(sql.trim())) rows = prepared.all(bindings);
      else prepared.run(bindings);
    } catch (error) {
      throw new Error(
        `Relational oracle could not execute the generated statement:\n${statement}\nSQLite translation:\n${sql}`,
        { cause: error },
      );
    }
  }
  return rows;
}
