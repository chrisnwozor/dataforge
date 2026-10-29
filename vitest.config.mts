import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "node",
    env: { DATAFORGE_AUTH: "off" },
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 2,
  },
});
