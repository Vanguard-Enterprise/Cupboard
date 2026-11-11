import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pin the zone before any test worker starts. Daylight-saving tests need a zone
// that has it, and a zone set inside a test file comes too late for dates built
// when the file loads, so CI (UTC) and a developer's machine would disagree.
process.env.TZ = "America/New_York";

export default defineConfig({
  // Kept outside node_modules so CI can restore it after `npm ci`. Vitest
  // reads its saved file durations here and starts the slowest files first.
  cacheDir: ".cache/vite",
  test: {
    setupFiles: ["./src/test/setup.ts"],
    // See src/test/setup.ts: CI shares its host with the Rust and image builds.
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
