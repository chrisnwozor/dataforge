import type { GeneratedFile, SqlGenerationInput } from "./types";
import { buildSqlContext } from "./context";
import { setupFile } from "./setup";
import { stagingFile } from "./staging";
import { dateFile } from "./date";
import { dimensionFile } from "./dimensions";
import { factFile } from "./fact";
import { checksFile } from "./checks";

/** Deterministic SQL generation: all metadata and time are supplied by the caller. */
export function generateSql(input: SqlGenerationInput): GeneratedFile[] {
  const context = buildSqlContext(input);
  return [
    setupFile(context),
    stagingFile(context),
    dateFile(context),
    dimensionFile(context),
    factFile(context),
    checksFile(context),
  ];
}

export { buildSqlContext } from "./context";
export {
  quoteIdentifier,
  sanitizeIdentifier,
  uniqueIdentifier,
  sqlLiteral,
  sqlType,
  textSqlType,
} from "./helpers";
export type {
  GeneratedFile,
  SqlGenerationInput,
  GenerationOptions,
  SqlColumn,
} from "./types";
