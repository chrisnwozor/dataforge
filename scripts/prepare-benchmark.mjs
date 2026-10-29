import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
// Reuse the existing Vitest/Vite development loader; no runtime dependency is added.
const { createServer } = await import(require.resolve("vite", { paths: [require.resolve("vitest/package.json")] }));
const loader = await createServer({ configFile: false, root: process.cwd(), resolve: { alias: { "@": process.cwd() } }, server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom", logLevel: "error" });
try {
  const { executePipeline } = await loader.ssrLoadModule("/lib/prepare/engine.ts");
  const { pipelineDefinitionSchema } = await loader.ssrLoadModule("/lib/prepare/schema.ts");
  const count = Number(process.env.DATAFORGE_BENCH_ROWS || 500_000);
  if (!Number.isSafeInteger(count) || count < 1 || count > 5_000_000) throw new Error("DATAFORGE_BENCH_ROWS must be between 1 and 5,000,000.");
  const source = { id: "main", columns: ["Name", "Sales", "Quantity"], async *open() { for (let row = 0; row < count; row++) yield { Name: "  aLEX   MORGAN  ", Sales: "125.50", Quantity: "2" }; } };
  const pipeline = pipelineDefinitionSchema.parse({ version: 1, mainSourceId: "main", steps: [
    { id: "clean", type: "cleanText", columns: ["Name"], operations: ["trim", "collapse", "title"] },
    { id: "derive", type: "derive", column: "Revenue", expression: "TONUMBER([Sales]) * TONUMBER([Quantity])" },
    { id: "filter", type: "filter", condition: { kind: "condition", column: "Quantity", operator: "gt", value: 0 }, mode: "keep" },
  ] });
  const execution = await executePipeline(pipeline, [source]);
  const started = performance.now(); let rows = 0;
  for await (const row of execution.rows) { if (row.Revenue !== 251) throw new Error("Benchmark output mismatch."); rows++; }
  const elapsedMs = performance.now() - started;
  console.log(JSON.stringify({ rows, elapsedMs: Math.round(elapsedMs), rowsPerSecond: Math.round(rows / elapsedMs * 1000), targetRowsPerSecond: 150_000, note: "Informational benchmark; not a required test." }, null, 2));
} finally { await loader.close(); }
