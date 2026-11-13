import { configSchema, type Config } from "../src/config/schema.js";

export const TEST_KEY = "test-key-0123456789abcdef";

/** A valid configuration with one Ollama backend and one key; override what a test needs. */
export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return configSchema.parse({
    backends: { ollama: { type: "ollama", url: "http://127.0.0.1:1" } },
    keys: [{ name: "test", key: TEST_KEY }],
    logging: { level: "silent" },
    ...overrides,
  });
}
