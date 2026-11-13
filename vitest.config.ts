import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests start real HTTP servers (stub backends); keep them isolated per file.
    pool: "forks",
  },
});
