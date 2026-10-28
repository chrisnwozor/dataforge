import { describe, expect, it } from "vitest";
import { instantiateQuery } from "@/lib/server/query-instance";
import type { CompiledQuery } from "@/lib/semantic/query/types";

const query = (sql: string, materialized = true): CompiledQuery => ({ sql, materialized, params: [], columns: [], limit: 1 });
describe("query-local temporary names", () => {
  it("gives every execution an independent suffix and preserves references/guarded cleanup", () => {
    const template = query("SELECT 1 INTO [#df_base]; SELECT * INTO [#df_agg] FROM [#df_base]; DROP TABLE IF EXISTS [#df_base]; DROP TABLE IF EXISTS [#df_agg];");
    const first = instantiateQuery(template);
    const second = instantiateQuery(template);
    const names = [...first.sql.matchAll(/\[#df_(?:base|agg)_([a-f0-9]{16})\]/g)];
    expect(names).toHaveLength(5);
    expect(new Set(names.map((match) => match[1])).size).toBe(1);
    expect(first.sql).not.toBe(second.sql);
    expect(first.sql).toContain("DROP TABLE IF EXISTS");
    expect(template.sql).toContain("INTO [#df_base]");
  });
  it("leaves literals, comments, and qualified source columns intact", () => {
    const original = "SELECT N'[#df_base] isn''t a table', [f] . [#df_base], [odd]]name] INTO [#df_base]; -- [#df_base]\n/* nested /* [#df_base] */ comment */ SELECT 1 FROM [#df_base];";
    const actual = instantiateQuery(query(original)).sql;
    expect(actual).toContain("N'[#df_base] isn''t a table'");
    expect(actual).toContain("[f] . [#df_base]");
    expect(actual).toContain("[odd]]name]");
    expect(actual).toContain("-- [#df_base]");
    expect(actual).toContain("/* nested /* [#df_base] */ comment */");
    expect([...actual.matchAll(/\[#df_base_[a-f0-9]{16}\]/g)]).toHaveLength(2);
  });
  it("does not rewrite or allocate an instance for a single-statement query", () => {
    const original = query("SELECT SUM([f].[Sales]) FROM [dw].[fact_sales] AS [f];", false);
    expect(instantiateQuery(original)).toBe(original);
  });
});
