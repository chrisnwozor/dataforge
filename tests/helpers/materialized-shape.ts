import { expect } from "vitest";

function tokens(sql: string): string[] {
  return [
    ...sql.matchAll(
      /\[(?:[^\]]|\]\])*\]|N?'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\/|#[A-Za-z_]\w*|[A-Za-z_]\w*|[(),.;]/g,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"));
}
const identifier = (value: string) =>
  value.startsWith("[") ? value.slice(1, -1).replaceAll("]]", "]") : value;

/** Simple aggregates need one relational statement and no tempdb work. */
export function assertFastShape(sql: string, grouped = true): void {
  expect(sql.match(/\bSELECT\b/gi)).toHaveLength(1);
  expect(sql.match(/\b(?:FROM|JOIN)\s+\[dw\]\.\[fact_sales\]/gi)).toHaveLength(1);
  expect(sql.match(/\bGROUP\s+BY\b/gi) ?? []).toHaveLength(grouped ? 1 : 0);
  expect(sql).not.toMatch(/#df_|DENSE_RANK|\bOVER\s*\(|\bWITH\b|\bINTO\b|\bDROP\b|\bCREATE\b/i);
  expect(sql).toMatch(/OPTION\s*\(\s*MAXDOP\s+2\s*,\s*MAX_GRANT_PERCENT\s*=\s*10\s*\)/i);
}

/** Structural properties prevent optimizer work from multiplying with references. */
export function assertMaterializedShape(sql: string): void {
  expect(
    sql.match(/\bINTO\s+(?:\[#df_base\]|#df_base)(?=\s|;)/gi),
  ).toHaveLength(1);
  expect(sql.match(/\b(?:FROM|JOIN)\s+\[dw\]\.\[fact_sales\]/gi)).toHaveLength(
    1,
  );
  expect(sql).toMatch(
    /CREATE\s+(?:UNIQUE\s+)?CLUSTERED\s+INDEX[\s\S]+?ON\s+(?:\[#df_base\]|#df_base)/i,
  );
  expect(sql).not.toMatch(/__df_scalar_\d+/);
  expect(sql).not.toContain("[__df_base]");
  const list = tokens(sql),
    ctes = new Map<string, string[]>(),
    cteSelects = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    if (
      list[i].toUpperCase() !== "WITH" ||
      list[i + 2]?.toUpperCase() !== "AS" ||
      list[i + 3] !== "("
    )
      continue;
    let at = i + 1;
    while (list[at + 1]?.toUpperCase() === "AS" && list[at + 2] === "(") {
      const name = identifier(list[at]);
      let depth = 1,
        j = at + 3;
      cteSelects.add(j);
      for (; j < list.length && depth; j++) {
        if (list[j] === "(") depth++;
        if (list[j] === ")") depth--;
      }
      ctes.set(name, list.slice(at + 3, j - 1));
      if (list[j] !== ",") break;
      at = j + 1;
    }
  }
  const references = (body: string[]) =>
    body
      .flatMap((token, i) =>
        /^(FROM|JOIN)$/i.test(token) && body[i + 1]
          ? [identifier(body[i + 1])]
          : [],
      )
      .filter((name) => ctes.has(name));
  const depth = (name: string, path = new Set<string>()): number => {
    expect(path.has(name), "CTEs must not recurse").toBe(false);
    return (
      1 +
      Math.max(
        0,
        ...references(ctes.get(name)!).map((child) =>
          depth(child, new Set([...path, name])),
        ),
      )
    );
  };
  expect(
    Math.max(0, ...[...ctes.keys()].map((name) => depth(name))),
  ).toBeLessThanOrEqual(3);
  const counts = references(list);
  for (const name of ctes.keys())
    expect(
      counts.filter((value) => value === name),
      `CTE ${name} must have one consumer`,
    ).toHaveLength(1);
  for (let i = 0; i < list.length; i++) {
    if (
      list[i].toUpperCase() === "SELECT" &&
      list[i - 1] === "(" &&
      !cteSelects.has(i)
    )
      throw new Error(
        "Scalar/derived SELECT subqueries are forbidden in materialized query plans.",
      );
    if (list[i].toUpperCase() !== "JOIN") continue;
    let j = i + 1;
    while (
      j < list.length &&
      list[j].toUpperCase() !== "ON" &&
      !/^(WHERE|GROUP|ORDER|JOIN|SELECT|DROP)$/i.test(list[j]) &&
      list[j] !== ";"
    )
      j++;
    if (list[j]?.toUpperCase() !== "ON") continue;
    for (
      j++;
      j < list.length &&
      !/^(WHERE|GROUP|ORDER|JOIN|LEFT|RIGHT|INNER|CROSS|SELECT|DROP)$/i.test(
        list[j],
      ) &&
      list[j] !== ";";
      j++
    )
      expect(
        list[j].toUpperCase(),
        "Join keys must not use OR-based null equality",
      ).not.toBe("OR");
  }
  expect(sql).toMatch(/BEGIN\s+CATCH/i);
  expect(sql).toMatch(/OPTION\s*\(\s*MAXDOP\s+2\s*,\s*MAX_GRANT_PERCENT\s*=\s*10\s*\)/i);
  const dropBase = /DROP TABLE IF EXISTS\s+(?:\[#df_base\]|#df_base)/gi;
  const catchAt = sql.search(/BEGIN\s+CATCH/i);
  expect(
    sql.slice(0, catchAt).match(dropBase),
    "Base cleanup after success",
  ).toHaveLength(1);
  expect(sql.indexOf("DROP TABLE IF EXISTS [#df_base]")).toBeGreaterThan(
    sql.indexOf("INTO [#df_base]"),
  );
  expect(
    sql.slice(catchAt).match(dropBase),
    "Base cleanup after SQL failure",
  ).toHaveLength(1);
}
