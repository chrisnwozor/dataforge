import { describe, expect, it } from "vitest";
import { resolveStagingPaths, sqlPathLiteral } from "@/lib/runner/paths";

const id = "11111111-1111-4111-8111-111111111111";

describe("SQL Server staging file paths", () => {
  it("uses a single UUID filename on the same Windows machine", () => {
    expect(
      resolveStagingPaths(id, String.raw`C:\Temp\SQL Data`, undefined, "win32"),
    ).toEqual({
      sqlPath: "C:\\Temp\\SQL Data\\" + id + ".csv",
      writePath: "C:\\Temp\\SQL Data\\" + id + ".csv",
      directory: String.raw`C:\Temp\SQL Data`,
    });
  });

  it("maps remote Windows staging to a local mounted share without changing SQL's path", () => {
    expect(
      resolveStagingPaths(id, String.raw`C:\Temp`, "/mnt/sql-staging", "linux"),
    ).toEqual({
      sqlPath: "C:\\Temp\\" + id + ".csv",
      writePath: `/mnt/sql-staging/${id}.csv`,
      directory: "/mnt/sql-staging",
    });
    expect(() =>
      resolveStagingPaths(id, String.raw`C:\Temp`, undefined, "linux"),
    ).toThrow(/DATAFORGE_STAGING_WRITE_DIR/);
  });

  it("supports UNC shares and POSIX SQL Server paths", () => {
    expect(
      resolveStagingPaths(
        id,
        String.raw`\\sqlhost\share\imports`,
        undefined,
        "win32",
      ).sqlPath,
    ).toBe("\\\\sqlhost\\share\\imports\\" + id + ".csv");
    expect(
      resolveStagingPaths(id, "/var/opt/mssql/staging", undefined, "linux")
        .writePath,
    ).toBe(`/var/opt/mssql/staging/${id}.csv`);
    expect(
      resolveStagingPaths(
        id,
        "/var/opt/mssql/staging",
        String.raw`D:\SqlShare`,
        "win32",
      ).writePath,
    ).toBe("D:\\SqlShare\\" + id + ".csv");
  });

  it("escapes apostrophes only as T-SQL Unicode string literal contents", () => {
    const path = "C:\\SQL Data\\O'Brien\\" + id + ".csv";
    expect(sqlPathLiteral(path)).toBe(`N'${path.replaceAll("'", "''")}'`);
  });

  it.each([
    "C:\\Temp\nDROP TABLE x",
    "C:\\Temp\r",
    "C:\\Temp\t",
    "C:\\Temp\0",
    "C:\\Temp\u0085",
    "C:\\Temp\u2028",
  ])("rejects control characters in %j", (folder) => {
    expect(() => resolveStagingPaths(id, folder, undefined, "win32")).toThrow(
      /control/,
    );
    expect(() => sqlPathLiteral(folder)).toThrow(/control/);
  });

  it.each([
    "relative",
    String.raw`C:relative`,
    String.raw`\root-relative`,
    String.raw`C:\Temp\..\secret`,
    "/tmp/../secret",
    String.raw`\\?\C:\Temp`,
    String.raw`C:\Temp:stream`,
    String.raw`C:\Temp\CON`,
  ])("rejects ambiguous or unsafe staging folder %s", (folder) => {
    expect(() =>
      resolveStagingPaths(id, folder, "/tmp/write", "linux"),
    ).toThrow();
  });

  it("validates local mappings, UUIDs, and final SQL path length", () => {
    expect(() =>
      resolveStagingPaths("../escape", "/tmp/staging", undefined, "linux"),
    ).toThrow(/project ID/);
    expect(() =>
      resolveStagingPaths(id, String.raw`C:\Temp`, "relative", "linux"),
    ).toThrow(/absolute/);
    expect(() =>
      resolveStagingPaths(id, "/" + "x".repeat(3990), undefined, "linux"),
    ).toThrow(/4,000/);
    expect(() => sqlPathLiteral("\ud800")).toThrow(/Unicode/);
  });
});
