import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      bun: fileURLToPath(new URL("./src/test/bun-shim.ts", import.meta.url)),
      "bun:sqlite": fileURLToPath(new URL("./src/test/bun-shim.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./src/test/setup.ts"],
    env: { HOME: "/tmp/infra-test-home" },
  },
});
