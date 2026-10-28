import { describe, expect, it } from "vitest";
import { splitSqlBatches } from "@/lib/runner/split-go";

describe("generated T-SQL GO batches", () => {
  it("splits complete GO lines without changing SQL or line numbering", () => {
    const batches = splitSqlBatches(
      "-- heading\r\nUSE [DataForge];\r\n gO \r\n\r\nSELECT 1;\r\nGO\r\nSELECT 2;",
    );
    expect(batches).toEqual([
      { sql: "-- heading\nUSE [DataForge];", startLine: 1, batchNumber: 1 },
      { sql: "\nSELECT 1;", startLine: 4, batchNumber: 2 },
      { sql: "SELECT 2;", startLine: 7, batchNumber: 3 },
    ]);
  });

  it("does not split GO in multiline strings or escaped string literals", () => {
    const sql =
      "DECLARE @s NVARCHAR(MAX) = N'first\nGO\nO''Brien';\nSELECT 'GO 5';\nGO\nSELECT 2;";
    const batches = splitSqlBatches(sql);
    expect(batches).toHaveLength(2);
    expect(batches[0].sql).toContain("first\nGO\nO''Brien");
    expect(batches[1]).toMatchObject({ startLine: 6, batchNumber: 2 });
  });

  it("does not split GO in bracket or double-quoted identifiers", () => {
    const sql =
      'SELECT [first]]name\nGO\nlast], "first""name\nGO\nlast" FROM [t];\nGO\nSELECT 2;';
    expect(splitSqlBatches(sql)).toHaveLength(2);
  });

  it("ignores line comments and nested block comments", () => {
    const sql =
      "-- GO\n/* outer\nGO\n/* inner\nGO 5\n*/\nGO\n*/\nSELECT 1; -- ' /* \nGO\nSELECT 2;";
    const batches = splitSqlBatches(sql);
    expect(batches).toHaveLength(2);
    expect(batches[1].startLine).toBe(11);
  });

  it.each([
    "GO 5",
    "go5",
    "GO -1",
    "GO +5",
    "GO 0",
    "GO 1",
    "GO;",
    "GO -- comment",
  ])(
    "rejects unsupported directive %s instead of repeating or sending it to SQL Server",
    (directive) =>
      expect(() =>
        splitSqlBatches(`SELECT 1;\n${directive}\nSELECT 2;`),
      ).toThrow(/Unsupported GO directive on line 2/),
  );

  it("skips empty and comment-only batches while retaining ordinal line offsets", () => {
    expect(
      splitSqlBatches(
        " \nGO\n-- only a comment\nGO\n/* nested */\nGO\nSELECT 1;\nGO\n",
      ),
    ).toEqual([{ sql: "SELECT 1;", startLine: 7, batchNumber: 1 }]);
    expect(splitSqlBatches("")).toEqual([]);
  });

  it.each([
    ["SELECT 'broken", /string literal.*line 1/],
    ['SELECT "broken', /quoted identifier.*line 1/],
    ["SELECT [broken", /quoted identifier.*line 1/],
    ["SELECT 1;\n/* broken", /block comment.*line 2/],
  ] as const)("rejects unterminated syntax in %s", (sql, message) => {
    expect(() => splitSqlBatches(sql)).toThrow(message);
  });
});
