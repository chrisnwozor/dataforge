/* eslint-disable @typescript-eslint/no-require-imports */
// This fixed worker evaluates only RegExp data. User strings are never code.
const { parentPort } = require("node:worker_threads");
const patterns = new Map();
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_MATCHES = 50_000;
function substitute(replacement, match, input) {
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (literal, token) => {
    if (token === "$") return "$";
    if (token === "&") return match[0];
    if (token === "`") return input.slice(0, match.index);
    if (token === "'") return input.slice(match.index + match[0].length);
    if (token[0] === "<") return match.groups ? match.groups[token.slice(1, -1)] ?? "" : literal;
    const index = Number(token);
    if (index > 0 && index < match.length) return match[index] ?? "";
    if (token.length === 2 && Number(token[0]) > 0 && Number(token[0]) < match.length) return (match[Number(token[0])] ?? "") + token[1];
    return literal;
  });
}
function replaceSafely(regex, input, replacement) {
  regex.lastIndex = 0;
  const chunks = []; let cursor = 0, length = 0, count = 0, match;
  const append = (chunk) => { length += chunk.length; if (length > MAX_OUTPUT) throw new Error("The regex replacement exceeds the 4 MB cell output limit."); chunks.push(chunk); };
  while ((match = regex.exec(input)) !== null) {
    if (++count > MAX_MATCHES) throw new Error("The regex matches too many times in one cell (maximum 50,000).");
    append(input.slice(cursor, match.index)); append(substitute(replacement, match, input));
    cursor = match.index + match[0].length;
    if (!regex.global) break;
    if (match[0].length === 0) {
      const point = input.codePointAt(regex.lastIndex);
      regex.lastIndex += regex.unicode && point > 0xffff ? 2 : 1;
      if (regex.lastIndex > input.length) break;
    }
  }
  append(input.slice(cursor)); return chunks.join("");
}
parentPort.on("message", ({ id, pattern, flags, operation, text, replacement }) => {
  try {
    const key = `${flags}\u0000${pattern}`;
    let regex = patterns.get(key);
    if (!regex) { regex = new RegExp(pattern, flags); patterns.set(key, regex); if (patterns.size > 64) patterns.delete(patterns.keys().next().value); }
    regex.lastIndex = 0;
    const value = operation === "test" ? regex.test(text) : replaceSafely(regex, text, replacement);
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : "Regex operation failed." }); }
});
parentPort.postMessage({ ready: true });
