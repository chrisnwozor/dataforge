import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "@/lib/server/db";
import {
  encryptPassword,
  decryptPassword,
  redactSecrets,
} from "@/lib/runner/secrets";
import {
  connectionConfig,
  friendlyConnectionError,
  getConnectionSettings,
  readPublicConnection,
  saveConnection,
} from "@/lib/server/connection";
import { GET, PUT } from "@/app/api/settings/connection/route";
import { POST as testConnection } from "@/app/api/settings/connection/test/route";

const driver = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
  configs: [] as unknown[],
}));
vi.mock("mssql", () => ({
  default: {
    ConnectionPool: class {
      constructor(config: unknown) {
        driver.configs.push(config);
      }
      on() {
        return this;
      }
      connect() {
        return driver.connect();
      }
      close() {
        return driver.close();
      }
      request() {
        return { query: driver.query };
      }
    },
  },
}));

const key = Buffer.alloc(32, 7).toString("base64");
const password = "s3cret]'\\not-a-regex.*";
const fields = () => ({
  server: "localhost",
  port: 1433,
  database: "DataForge",
  user: "dataforge_login",
  password,
  encrypt: true,
  trustServerCertificate: true,
  stagingFolder: "C:\\Temp\\DataForge",
});
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dataforge-connection-"));
  vi.stubEnv("DATAFORGE_DATA_DIR", directory);
  vi.stubEnv("DATAFORGE_SECRET", key);
  driver.connect.mockReset().mockResolvedValue(undefined);
  driver.query.mockReset().mockResolvedValue({
    recordset: [
      { version: "Microsoft SQL Server 2019", database: "DataForge" },
    ],
  });
  driver.close.mockReset().mockResolvedValue(undefined);
  driver.configs.length = 0;
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function request(
  body: unknown,
  headers = { "content-type": "application/json" },
) {
  return new Request("http://localhost/api/settings/connection", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

describe("AES-256-GCM SQL password encryption", () => {
  it("round-trips Unicode, punctuation, and empty strings with random IVs", () => {
    for (const value of [password, "秘密 🔐", ""]) {
      const encrypted = encryptPassword(value);
      expect(encrypted).not.toContain(value || "a value that is not present");
      expect(encrypted).not.toBe(encryptPassword(value));
      expect(decryptPassword(encrypted)).toBe(value);
    }
  });
  it("accepts a generated 32-byte hex key and rejects malformed or missing keys", () => {
    vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 8).toString("hex"));
    expect(decryptPassword(encryptPassword(password))).toBe(password);
    for (const value of ["", "short", "x".repeat(44), key.replace(/=$/, "A")]) {
      vi.stubEnv("DATAFORGE_SECRET", value);
      expect(() => encryptPassword(password)).toThrow(/DATAFORGE_SECRET/);
    }
  });
  it("authenticates both ciphertext and tag and fails safely after a key change", () => {
    const original = encryptPassword(password);
    const parts = original.split(":");
    for (const index of [1, 2, 3]) {
      const changed = [...parts];
      changed[index] =
        (changed[index][0] === "A" ? "B" : "A") + changed[index].slice(1);
      expect(() => decryptPassword(changed.join(":"))).toThrow(
        /could not be unlocked/,
      );
    }
    vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 9).toString("base64"));
    expect(() => decryptPassword(original)).toThrow(/could not be unlocked/);
  });
  it("redacts literal secrets without interpreting punctuation as regex syntax", () => {
    expect(
      redactSecrets(`Error ${password} ${key} ${password}`, [password, key]),
    ).toBe("Error [redacted] [redacted] [redacted]");
  });
});

describe("persisted SQL authentication settings", () => {
  it.each(["\nC:\\Temp", "C:\\Temp\r", "/tmp/\u0085staging"])(
    "rejects control characters before trimming a staging path (%j)",
    async (stagingFolder) => {
      const response = await PUT(request({ ...fields(), stagingFolder }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/control characters/i);
      expect(readPublicConnection().configured).toBe(false);
    },
  );
  it("stores only encrypted credentials and returns masked public fields across reopen", async () => {
    const saved = await PUT(request(fields()));
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.connection).toMatchObject({
      server: "localhost",
      port: 1433,
      database: "DataForge",
      user: "dataforge_login",
      passwordSaved: true,
      secretConfigured: true,
      configured: true,
    });
    expect(JSON.stringify(body)).not.toContain(password);
    expect(body.connection).not.toHaveProperty("password");
    expect(body.connection).not.toHaveProperty("passwordEncrypted");
    const row = getDatabase()
      .prepare(
        "SELECT password_encrypted FROM connection_settings WHERE id = 1",
      )
      .get()!;
    expect(row.password_encrypted).not.toBe(password);
    expect(String(row.password_encrypted)).toMatch(/^v2:primary:/);
    closeDatabase();
    expect(getConnectionSettings().password).toBe(password);
    expect(JSON.stringify(await (await GET()).json())).not.toContain(password);
  });
  it("preserves a saved password when a masked form sends an empty value", () => {
    saveConnection(fields());
    saveConnection({ ...fields(), server: "sql.example.test", password: "" });
    expect(getConnectionSettings()).toMatchObject({
      server: "sql.example.test",
      password,
    });
    const config = connectionConfig(getConnectionSettings(), 1234);
    expect(config).toMatchObject({
      user: "dataforge_login",
      password,
      requestTimeout: 1234,
      connectionTimeout: 10000,
      pool: { max: 1 },
      options: { encrypt: true, trustServerCertificate: true },
    });
    expect(config).not.toHaveProperty("authentication.options.domain");
  });
  it("requires a valid secret for writes and disables configured state when a stored password cannot decrypt", async () => {
    vi.stubEnv("DATAFORGE_SECRET", "");
    expect(readPublicConnection()).toMatchObject({
      configured: false,
      passwordSaved: false,
      secretConfigured: false,
    });
    const failed = await PUT(request(fields()));
    expect(failed.status).toBe(503);
    expect((await failed.json()).error).toContain("DATAFORGE_SECRET");
    expect(
      getDatabase()
        .prepare("SELECT COUNT(*) AS n FROM connection_settings")
        .get()?.n,
    ).toBe(0);
    vi.stubEnv("DATAFORGE_SECRET", key);
    saveConnection(fields());
    vi.stubEnv("DATAFORGE_SECRET", Buffer.alloc(32, 9).toString("base64"));
    expect(readPublicConnection()).toMatchObject({
      configured: false,
      passwordSaved: true,
      secretConfigured: true,
    });
    expect(() => getConnectionSettings()).toThrow(/could not be unlocked/);
  });
  it("rejects invalid fields, relative/control-character paths, arbitrary connection strings, and oversized bodies", async () => {
    for (const changes of [
      { port: 0 },
      { port: 65536 },
      { database: "" },
      { user: "" },
      { stagingFolder: "../outside" },
      { stagingFolder: "C:\\Temp\nDROP" },
      { server: "host\r\nother" },
      { connectionString: "Server=somewhere" },
    ])
      expect((await PUT(request({ ...fields(), ...changes }))).status).toBe(
        400,
      );
    expect(
      (await PUT(request(fields(), { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect(
      (
        await PUT(
          new Request("http://localhost", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await PUT(request({ ...fields(), password: "x".repeat(20_000) })))
        .status,
    ).toBe(413);
    expect((await PUT(request({ ...fields(), password: "" }))).status).toBe(
      400,
    );
  });
});

describe("SQL connection tests", () => {
  it("uses SQL authentication and reports version/database without returning the password", async () => {
    saveConnection(fields());
    const response = await testConnection(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      version: "Microsoft SQL Server 2019",
      database: "DataForge",
    });
    expect(driver.configs[0]).toMatchObject({
      server: "localhost",
      database: "DataForge",
      user: "dataforge_login",
      password,
      options: { encrypt: true, trustServerCertificate: true },
    });
    expect(driver.query).toHaveBeenCalledWith(
      "SELECT @@VERSION AS [version], DB_NAME() AS [database]",
    );
    expect(driver.close).toHaveBeenCalledOnce();
  });
  it.each([
    ["ELOGIN", "Login failed for user", "Login failed"],
    ["ESOCKET", "connect ECONNREFUSED", "Cannot reach SQL Server"],
    ["ESOCKET", "self-signed certificate", "TLS connection failed"],
    [
      "EDATABASE",
      "Cannot open database requested by login",
      "database could not be opened",
    ],
  ])(
    "makes %s failure friendly and closes its pool",
    async (code, message, expected) => {
      driver.connect.mockRejectedValue(
        Object.assign(new Error(`${message}: ${password}`), { code }),
      );
      const response = await testConnection(request(fields()));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain(expected);
      expect(JSON.stringify(body)).not.toContain(password);
      expect(driver.close).toHaveBeenCalledOnce();
    },
  );
  it("does not expose password-like content returned by a server", async () => {
    driver.query.mockResolvedValue({
      recordset: [
        { version: `Version: ${password}`, database: `DB ${password}` },
      ],
    });
    const response = await testConnection(request(fields()));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(password);
    expect(
      friendlyConnectionError(new Error(password), password),
    ).not.toContain(password);
  });
});
