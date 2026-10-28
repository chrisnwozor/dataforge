import type { config as MssqlConfig } from "mssql";
import { z } from "zod";
import {
  decryptPassword,
  encryptPassword,
  redactSecrets,
  secretKey,
} from "@/lib/runner/secrets";
import { getDatabase } from "./db";
import { boundedBody, HttpError } from "./http";

const text = (label: string, max: number) =>
  z
    .string()
    .refine(
      (value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value),
      `${label} cannot contain control characters or line breaks.`,
    )
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`);

export const connectionFieldsSchema = z
  .object({
    server: text("Server", 255),
    port: z.number().int().min(1).max(65_535).default(1433),
    database: text("Database", 128),
    user: text("SQL login", 128),
    password: z.string().max(1024).optional(),
    encrypt: z.boolean().default(true),
    trustServerCertificate: z.boolean().default(true),
    stagingFolder: text("Staging folder", 3900).refine(
      (value) =>
        value.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        /^\\\\[^\\]+\\[^\\]+/.test(value),
      "Staging folder must be an absolute Windows, UNC, or POSIX folder path.",
    ),
  })
  .strict();

export type ConnectionFields = z.infer<typeof connectionFieldsSchema>;
export interface SqlConnectionSettings extends Omit<
  ConnectionFields,
  "password"
> {
  password: string;
}
export interface PublicConnection extends Omit<ConnectionFields, "password"> {
  passwordSaved: boolean;
  configured: boolean;
  secretConfigured: boolean;
  updatedAt: string | null;
  configurationError: string | null;
}

interface ConnectionRow {
  server: string;
  port: number;
  database: string;
  user: string;
  passwordEncrypted: string;
  encrypt: number;
  trustServerCertificate: number;
  stagingFolder: string;
  updatedAt: string;
}

function readConnectionRow(): ConnectionRow | undefined {
  return getDatabase()
    .prepare(
      `SELECT server, port, database_name AS "database", username AS "user",
        password_encrypted AS passwordEncrypted, encrypt,
        trust_server_certificate AS trustServerCertificate,
        staging_folder AS stagingFolder, updated_at AS updatedAt
      FROM connection_settings WHERE id = 1`,
    )
    .get() as (ConnectionRow & Record<string, string | number>) | undefined;
}

function rowFields(
  row: ConnectionRow,
): Omit<SqlConnectionSettings, "password"> {
  return {
    server: row.server,
    port: row.port,
    database: row.database,
    user: row.user,
    encrypt: row.encrypt === 1,
    trustServerCertificate: row.trustServerCertificate === 1,
    stagingFolder: row.stagingFolder,
  };
}

export function readPublicConnection(): PublicConnection {
  const row = readConnectionRow();
  let configurationError: string | null = null;
  let secretConfigured = false;
  let decryptable = false;
  try {
    secretKey();
    secretConfigured = true;
    if (row) {
      decryptPassword(row.passwordEncrypted);
      decryptable = true;
    }
  } catch (error) {
    configurationError =
      error instanceof Error
        ? error.message
        : "Connection encryption is unavailable.";
  }
  return {
    ...(row
      ? rowFields(row)
      : {
          server: "localhost",
          port: 1433,
          database: "DataForge",
          user: "",
          encrypt: true,
          trustServerCertificate: true,
          stagingFolder: "",
        }),
    passwordSaved: !!row?.passwordEncrypted,
    configured: !!row && decryptable,
    secretConfigured,
    updatedAt: row?.updatedAt ?? null,
    configurationError,
  };
}

export function getConnectionSettings(): SqlConnectionSettings {
  const row = readConnectionRow();
  if (!row)
    throw new HttpError(
      409,
      "Save a SQL Server connection in Settings before starting a run.",
    );
  try {
    return {
      ...rowFields(row),
      password: decryptPassword(row.passwordEncrypted),
    };
  } catch (error) {
    throw new HttpError(
      503,
      error instanceof Error
        ? error.message
        : "The saved password could not be unlocked.",
    );
  }
}

export const decryptConnection = getConnectionSettings;

function checkedFields(value: unknown): ConnectionFields {
  const parsed = connectionFieldsSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid connection settings.",
    );
  return parsed.data;
}

export function saveConnection(value: unknown): PublicConnection {
  const fields = checkedFields(value);
  const previous = readConnectionRow();
  let passwordEncrypted: string;
  try {
    secretKey();
    if (fields.password) passwordEncrypted = encryptPassword(fields.password);
    else if (previous) {
      decryptPassword(previous.passwordEncrypted);
      passwordEncrypted = previous.passwordEncrypted;
    } else
      throw new HttpError(
        400,
        "Enter the SQL login password before saving the connection.",
      );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      error instanceof Error
        ? error.message
        : "Password encryption is unavailable.",
    );
  }
  getDatabase()
    .prepare(
      `INSERT INTO connection_settings (id, server, port, database_name, username,
        password_encrypted, encrypt, trust_server_certificate, staging_folder, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET server = excluded.server, port = excluded.port,
        database_name = excluded.database_name, username = excluded.username,
        password_encrypted = excluded.password_encrypted, encrypt = excluded.encrypt,
        trust_server_certificate = excluded.trust_server_certificate,
        staging_folder = excluded.staging_folder, updated_at = excluded.updated_at`,
    )
    .run(
      fields.server,
      fields.port,
      fields.database,
      fields.user,
      passwordEncrypted,
      fields.encrypt ? 1 : 0,
      fields.trustServerCertificate ? 1 : 0,
      fields.stagingFolder,
      new Date().toISOString(),
    );
  return readPublicConnection();
}

/** Every caller gets a dedicated pool; no global mssql connection is shared. */
export function connectionConfig(
  connection: SqlConnectionSettings,
  requestTimeout = 600_000,
): MssqlConfig {
  return {
    server: connection.server,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    connectionTimeout: 10_000,
    requestTimeout,
    pool: { max: 1, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: connection.encrypt,
      trustServerCertificate: connection.trustServerCertificate,
      enableArithAbort: true,
      appName: "DataForge",
    },
  };
}

/** Friendly public errors deliberately avoid serializing driver/config objects. */
export function friendlyConnectionError(
  error: unknown,
  password?: string,
): string {
  const value = error instanceof Error ? error : null;
  const code = value && "code" in value ? String(value.code) : "";
  const message = redactSecrets(value?.message ?? "", [
    password ?? "",
    process.env.DATAFORGE_SECRET ?? "",
  ]);
  if (
    code === "ELOGIN" ||
    /login failed|18456|authentication failed/i.test(message)
  )
    return "Login failed. Check the SQL login and password, enable SQL Server authentication, and confirm access to the selected database.";
  if (/certificate|TLS|SSL|self.signed|CERT_/i.test(`${code} ${message}`))
    return "TLS connection failed. Check SQL Server's certificate and encryption settings. Trust server certificate is intended for local development.";
  if (/cannot open database|4060|database.*not.*exist/i.test(message))
    return "The database could not be opened. Check its name and grant this SQL login access.";
  if (
    /ETIMEOUT|ESOCKET|ECONN|ENOTFOUND|EHOST|EINSTLOOKUP/i.test(
      `${code} ${message}`,
    )
  )
    return "Cannot reach SQL Server. Check the server and TCP port, enable TCP/IP, and allow the connection through the firewall.";
  return "SQL Server could not be reached or rejected the connection. Check the connection settings and server configuration.";
}

export interface ConnectionTestResult {
  success: true;
  version: string;
  database: string;
  message: string;
}

export async function testConnection(
  value?: unknown,
): Promise<ConnectionTestResult> {
  let settings: SqlConnectionSettings;
  if (
    value === undefined ||
    (typeof value === "object" && value !== null && !Object.keys(value).length)
  ) {
    settings = getConnectionSettings();
  } else {
    const fields = checkedFields(value);
    settings = {
      ...fields,
      password: fields.password || getConnectionSettings().password,
    };
  }
  const { default: sql } = await import("mssql");
  const pool = new sql.ConnectionPool(connectionConfig(settings, 10_000));
  // Pool-level socket failures may also emit an error event; handle them without logging secrets.
  pool.on("error", () => {});
  try {
    await pool.connect();
    const result = await pool
      .request()
      .query("SELECT @@VERSION AS [version], DB_NAME() AS [database]");
    const row = result.recordset[0] as
      { version?: unknown; database?: unknown } | undefined;
    const version = redactSecrets(String(row?.version ?? "SQL Server"), [
      settings.password,
      process.env.DATAFORGE_SECRET ?? "",
    ]);
    const database = redactSecrets(String(row?.database ?? settings.database), [
      settings.password,
      process.env.DATAFORGE_SECRET ?? "",
    ]);
    return {
      success: true,
      version,
      database,
      message: "Connection succeeded using SQL authentication.",
    };
  } catch (error) {
    throw new HttpError(400, friendlyConnectionError(error, settings.password));
  } finally {
    await pool.close().catch(() => {});
  }
}

export async function readConnectionRequest(
  request: Request,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "Send connection settings as JSON.");
  try {
    return await new Response(await boundedBody(request, 16 * 1024)).json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "The connection request is not valid JSON.");
  }
}
