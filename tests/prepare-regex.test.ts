import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeRegexWorkers, compileSafeRegex, REGEX_INPUT_LIMIT, RegexTimeoutError } from "@/lib/prepare/safe-regex";

afterEach(async () => { await closeRegexWorkers(); });
describe("isolated bounded regex", () => {
  it("reuses compiled patterns across rows and resets stateful global matches", async () => {
    const regex = await compileSafeRegex("^abc", "gi");
    expect(await regex.test("Abc value")).toBe(true);
    expect(await regex.test("Abc value")).toBe(true);
    expect(await regex.test("different")).toBe(false);
    await regex.close();
    await expect(regex.test("abc")).rejects.toThrow(/closed/);
  });
  it("supports exact JS replacement groups and zero-width Unicode advancement without user code", async () => {
    const regex = await compileSafeRegex("(?<name>ab)(c)", "g");
    expect(await regex.replace("abc abc", "$<name>-$2-$$-$&")).toBe("ab-c-$-abc ab-c-$-abc");
    await regex.close();
    const zero = await compileSafeRegex("", "gu");
    expect(await zero.replace("😀x", "-")).toBe("-😀-x-");
    await zero.close();
  });
  it("enforces syntax, pattern, flags, input, and replacement limits", async () => {
    await expect(compileSafeRegex("a".repeat(257))).rejects.toThrow(/256/);
    await expect(compileSafeRegex("[")).rejects.toThrow(/invalid/);
    await expect(compileSafeRegex("x", "gg")).rejects.toThrow(/flag/);
    await expect(compileSafeRegex("(x)\\1")).rejects.toThrow(/backreference/);
    await expect(compileSafeRegex("(a+)+$")).rejects.toThrow(/Nested/);
    const regex = await compileSafeRegex("x");
    await expect(regex.test("x".repeat(REGEX_INPUT_LIMIT + 1))).rejects.toThrow(/1 MB/);
    await expect(regex.replace("x", "x".repeat(4097))).rejects.toThrow(/4,096/);
    await regex.close();
  });
  it("terminates ambiguous backtracking after the real execution deadline and recovers the pool", async () => {
    const expensive = await compileSafeRegex("^(a|aa)+$");
    const started = performance.now();
    await expect(expensive.test("a".repeat(80) + "!")).rejects.toBeInstanceOf(RegexTimeoutError);
    expect(performance.now() - started).toBeLessThan(2500);
    const simple = await compileSafeRegex("ok");
    expect(await simple.test("ok")).toBe(true);
    await expensive.close();
    expect(await simple.test("ok")).toBe(true);
    await simple.close();
  });
  it("cancels an in-flight worker without leaking a lease or preventing later handles", async () => {
    const regex = await compileSafeRegex("^(a|aa)+$");
    const controller = new AbortController();
    const pending = regex.test("a".repeat(80) + "!", controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await regex.close();
    const next = await compileSafeRegex("ok");
    expect(await next.test("ok")).toBe(true);
    await next.close();
  });
  it("bounds replacement growth and matches rather than allocating an unbounded string", async () => {
    const regex = await compileSafeRegex("x", "g");
    await expect(regex.replace("x".repeat(2000), "z".repeat(4096))).rejects.toThrow(/output limit/);
    await regex.close();
    const empty = await compileSafeRegex("", "g");
    await expect(empty.replace("x".repeat(50_001), "")).rejects.toThrow(/50,000|100 ms/);
    await empty.close();
  });
  it("shares workers among many compiled handles and closes one without affecting another", async () => {
    const patterns = await Promise.all(Array.from({ length: 20 }, (_, index) => compileSafeRegex(`^${index}$`)));
    expect(await Promise.all(patterns.map((pattern, index) => pattern.test(String(index))))).toEqual(Array(20).fill(true));
    await patterns[0].close();
    expect(await patterns[1].test("1")).toBe(true);
    await Promise.all(patterns.slice(1).map((pattern) => pattern.close()));
  });
  it("rejects a missing deployment worker asset instead of continually respawning or hanging", async () => {
    const moduleUrl = pathToFileURL(resolve("lib/prepare/safe-regex.ts")).href;
    const script = `import { compileSafeRegex } from ${JSON.stringify(moduleUrl)}; const regex = await compileSafeRegex('ok'); try { await regex.test('ok'); process.exitCode = 1; } catch (error) { console.log(error.message); } finally { await regex.close(); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", script], { cwd: tmpdir(), timeout: 4000 });
    expect(stdout).toContain("regex service could not start");
  });
});
