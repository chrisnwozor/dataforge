import { describe, expect, it } from "vitest";
import { compileRowExpression } from "@/lib/prepare/expression";
import { addCalendarDate, convertCell } from "@/lib/prepare/conversion";

const row = { Sales: "100", Profit: "12.53", Name: "  Café Name  ", Quantity: "4", Empty: null, Date: "2024-02-29", Flag: "yes", "Escaped] column": "safe" };
const evaluate = (source: string) => compileRowExpression(source, Object.keys(row))(row);

describe("safe row expression compilation", () => {
  it("reuses references in a compiled closure and honors arithmetic precedence", () => {
    const compiled = compileRowExpression("[Profit] / [Sales] * 100 + [Quantity]", Object.keys(row));
    expect(compiled(row)).toBeCloseTo(16.53, 10);
    expect(compiled({ ...row, Sales: "200" })).toBeCloseTo(10.265, 10);
    expect(compiled.referencedColumns).toEqual(["Profit", "Sales", "Quantity"]);
    expect(evaluate("([Sales] + 20) / [Quantity]")).toBe(30);
  });
  it("handles escaped column names and case-insensitive unambiguous references", () => {
    expect(evaluate("[Escaped]] column]")).toBe("safe");
    expect(evaluate("[sales]")).toBe("100");
    expect(() => compileRowExpression("[SALES]", ["Sales", "sales"])).toThrow(/ambiguous.*position/i);
    expect(() => compileRowExpression("[Unknown] + 1", Object.keys(row))).toThrow(/Unknown.*position 1/);
  });
  it.each([
    ["IF([Quantity] > 2, 'large', 'small')", "large"],
    ["IF(FALSE, TONUMBER('bad'), 'safe')", "safe"],
    ["COALESCE([Empty], NULL, [Name])", row.Name],
    ["COALESCE('', 'fallback')", ""],
    ["CONCAT(TRIM([Name]), ' / ', [Quantity], NULL)", "Café Name / 4"],
    ["UPPER('Mixed')", "MIXED"], ["LOWER('Mixed')", "mixed"],
    ["LEFT('abcdef', 3)", "abc"], ["RIGHT('abcdef', 2)", "ef"], ["RIGHT('abcdef', 0)", ""],
    ["SUBSTRING('abcdef', 2, 3)", "bcd"], ["LEN('Café')", 4],
    ["REPLACE('a-b-a', 'a', 'X')", "X-b-X"],
    ["ROUND(12.535, 2)", 12.54], ["ROUND(1.005, 2)", 1.01], ["ROUND(-1.005, 2)", -1.01], ["ROUND(-1.5)", -2], ["ROUND(1234, -2)", 1200],
    ["ABS(-4)", 4], ["TONUMBER(' 1.25e2 ')", 125],
    ["TODATE('31/12/2024', 'dd/MM/yyyy')", "2024-12-31"],
    ["YEAR([Date])", 2024], ["MONTH([Date])", 2], ["DAY([Date])", 29],
    ["DATEADD(MONTH, 1, '2024-01-31')", "2024-02-29"],
    ["DATEADD('YEAR', 1, '2024-02-29')", "2025-02-28"],
    ["DATEDIFF(DAY, '2024-02-28', '2024-03-01')", 2],
    ["DATEDIFF(MONTH, '2023-12-31', '2024-01-01')", 1],
    ["DATEDIFF(QUARTER, '2023-12-31', '2024-01-01')", 1],
  ])("evaluates %s", (source, expected) => { expect(evaluate(source)).toEqual(expected); });
  it("uses NULL propagation, three-valued logic, numeric comparisons, and safe division", () => {
    for (const expression of ["[Empty] + 1", "[Empty] = 1", "1 / 0", "1 % 0", "YEAR('')", "TODATE('')", "DATEADD(DAY, 1, '')", "DATEDIFF(DAY, '', [Date])", "NOT NULL", "NULL AND TRUE", "NULL OR FALSE"]) expect(evaluate(expression)).toBeNull();
    expect(evaluate("NULL AND FALSE")).toBe(false);
    expect(evaluate("NULL OR TRUE")).toBe(true);
    expect(evaluate("IF(NULL, 'yes', 'no')")).toBe("no");
    expect(evaluate("[Quantity] < '10'")).toBe(true);
    expect(evaluate("NOT [Flag]")).toBe(false);
    expect(compileRowExpression("[Missing] + 1", ["Missing"])({ Missing: "" })).toBeNull();
  });
  it("reports function, type, and runtime errors with positions", () => {
    for (const expression of ["UPPER(3)", "ROUND('text')", "IF(1, 2, 3)", "ABS(1, 2)", "LEFT('a', 'b')", "DATEADD(HOUR, 1, [Date])", "DATEADD([Name], 1, [Date])"]) expect(() => compileRowExpression(expression, Object.keys(row))).toThrow(/position/);
    for (const expression of ["TONUMBER('bad')", "ROUND(1, 100)", "SUBSTRING('abc', 0, 1)", "TODATE('2024-02-30')", "1e308 * 1e308"]) expect(() => evaluate(expression)).toThrow(/position/);
  });
  it("rejects injection-like JavaScript, statements, object access, and excess complexity", () => {
    for (const expression of ["process.exit()", "eval('1')", "CONCAT.constructor('return process')()", "[Name]; DROP TABLE projects", "[Name] -- comment", "[Name] /* comment */", "(()=>1)()", "fetch('https://example.com')"]) expect(() => compileRowExpression(expression, Object.keys(row))).toThrow();
    expect(() => compileRowExpression("1".repeat(2001), [])).toThrow(/2,000/);
    expect(() => compileRowExpression("(".repeat(13) + "1" + ")".repeat(13), [])).toThrow(/12 levels/);
  });
  it("bounds derived text growth before a replacement or concatenation can allocate huge output", () => {
    const replace = compileRowExpression("REPLACE([Text], 'x', [Replacement])", ["Text", "Replacement"]);
    expect(() => replace({ Text: "x".repeat(2000), Replacement: "large".repeat(1000) })).toThrow(/1 MB.*position/);
    const concat = compileRowExpression("CONCAT([Text], [Text])", ["Text"]);
    expect(() => concat({ Text: "x".repeat(600_000) })).toThrow(/1 MB.*position/);
  });
});

describe("strict cell conversions", () => {
  it("handles nullable values, finite numbers, exact integers, booleans and text", () => {
    for (const value of [null, "", "  "]) expect(convertCell(value, "decimal")).toBeNull();
    expect(convertCell("42", "integer")).toBe(42);
    expect(convertCell("-1.25e2", "decimal")).toBe(-125);
    expect(convertCell("yes", "boolean")).toBe(true);
    expect(convertCell("0", "boolean")).toBe(false);
    expect(convertCell(0, "boolean")).toBe(false);
    expect(convertCell(false, "text")).toBe("false");
    for (const value of ["Infinity", "NaN", "1,000", true, "1e999"]) expect(() => convertCell(value, "decimal")).toThrow();
    for (const value of ["1.1", "9007199254740993"]) expect(() => convertCell(value, "integer")).toThrow();
    expect(() => convertCell("maybe", "boolean")).toThrow(/boolean/);
  });
  it("parses explicit date patterns without accepting impossible dates or JS parser rollover", () => {
    expect(convertCell("29/02/2024", "date", "dd/MM/yyyy")).toBe("2024-02-29");
    expect(convertCell("02/29/2024", "date", "MM/dd/yyyy")).toBe("2024-02-29");
    expect(convertCell("20240229", "date", "yyyyMMdd")).toBe("2024-02-29");
    expect(convertCell("2024-02-29T13:20:10.000Z", "date")).toBe("2024-02-29");
    for (const value of ["2023-02-29", "2024-02-30", "0000-01-01", "2024-13-01"]) expect(() => convertCell(value, "date")).toThrow(/date/);
    expect(() => convertCell("29/02/2023", "date", "dd/MM/yyyy")).toThrow();
    expect(() => convertCell("2024", "date", "yyyy")).toThrow(/pattern/);
  });
  it("clamps date arithmetic across leap years and rejects overflow", () => {
    expect(addCalendarDate("2024-03-31", "MONTH", -1)).toBe("2024-02-29");
    expect(addCalendarDate("2024-02-29", "YEAR", 1)).toBe("2025-02-28");
    expect(addCalendarDate("2024-02-29", "WEEK", -1)).toBe("2024-02-22");
    expect(() => addCalendarDate("9999-12-31", "DAY", 1)).toThrow();
  });
});
