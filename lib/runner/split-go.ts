export interface SqlBatch {
  sql: string;
  /** Original script line corresponding to line 1 of this batch. */
  startLine: number;
  batchNumber: number;
}

type Quote = "single" | "double" | "bracket" | null;

/**
 * GO is a client batch separator, not T-SQL. Recognize it only as a complete
 * unquoted line; never split the generated function text stored in N'...'.
 */
export function splitSqlBatches(sql: string): SqlBatch[] {
  const lines = sql.replace(/\r\n?/g, "\n").split("\n");
  const batches: SqlBatch[] = [];
  let quote: Quote = null;
  let quoteLine = 0;
  let blockDepth = 0;
  let blockLine = 0;
  let current: string[] = [];
  let startLine = 1;
  let hasCode = false;

  const finish = () => {
    if (hasCode)
      batches.push({
        sql: current.join("\n"),
        startLine,
        batchNumber: batches.length + 1,
      });
    current = [];
    hasCode = false;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (quote === null && blockDepth === 0) {
      if (/^GO$/i.test(trimmed)) {
        finish();
        startLine = lineIndex + 2;
        continue;
      }
      if (/^GO(?:\s|[\d+;-]|$)/i.test(trimmed))
        throw new Error(
          `Unsupported GO directive on line ${lineIndex + 1}. Use GO on its own line; repeat counts such as GO 5 are not allowed.`,
        );
    }
    current.push(line);
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      const next = line[index + 1];
      if (quote !== null) {
        const closing =
          quote === "single" ? "'" : quote === "double" ? '"' : "]";
        if (char === closing && next === closing) index++;
        else if (char === closing) quote = null;
        continue;
      }
      if (blockDepth > 0) {
        if (char === "/" && next === "*") {
          blockDepth++;
          index++;
        } else if (char === "*" && next === "/") {
          blockDepth--;
          index++;
        }
        continue;
      }
      if (char === "-" && next === "-") break;
      if (char === "/" && next === "*") {
        blockDepth = 1;
        blockLine = lineIndex + 1;
        index++;
      } else if (char === "'" || char === '"' || char === "[") {
        quote = char === "'" ? "single" : char === '"' ? "double" : "bracket";
        quoteLine = lineIndex + 1;
        hasCode = true;
      } else if (char.trim() !== "" && char !== ";") {
        hasCode = true;
      }
    }
  }
  if (quote !== null)
    throw new Error(
      `Unterminated SQL ${quote === "single" ? "string literal" : "quoted identifier"} starting on line ${quoteLine}.`,
    );
  if (blockDepth > 0)
    throw new Error(
      `Unterminated SQL block comment starting on line ${blockLine}.`,
    );
  finish();
  return batches;
}
