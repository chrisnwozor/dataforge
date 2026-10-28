import { randomBytes } from "node:crypto";
import type { CompiledQuery } from "@/lib/semantic/query/types";

/** Instantiate only generator-owned temporary identifiers, never values or source columns. */
export function instantiateQuery(compiled: CompiledQuery): CompiledQuery {
  if (!compiled.materialized) return compiled;
  const suffix = randomBytes(8).toString("hex");
  const sql = compiled.sql;
  let output = "";
  let index = 0;
  while (index < sql.length) {
    const start = index;
    if (sql[index] === "'") {
      index++;
      while (index < sql.length) {
        if (sql[index++] === "'") {
          if (sql[index] === "'") index++;
          else break;
        }
      }
    } else if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", index)) {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth) {
        if (sql.startsWith("/*", index)) { depth++; index += 2; }
        else if (sql.startsWith("*/", index)) { depth--; index += 2; }
        else index++;
      }
    } else if (sql[index] === "[") {
      index++;
      while (index < sql.length) {
        if (sql[index++] === "]") {
          if (sql[index] === "]") index++;
          else break;
        }
      }
      const identifier = sql.slice(start + 1, index - 1);
      let previous = start - 1;
      while (previous >= 0 && /\s/.test(sql[previous])) previous--;
      if (/^#df_[a-z0-9_]+$/i.test(identifier) && sql[previous] !== ".") {
        output += `[${identifier}_${suffix}]`;
        continue;
      }
    } else index++;
    output += sql.slice(start, index);
  }
  return { ...compiled, sql: output };
}
