import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config/load.js";

const minimal = `
backends:
  ollama:
    type: ollama
    url: http://localhost:11434/
keys:
  - name: team
    key: secret-team-key
`;

function problems(text: string, env: NodeJS.ProcessEnv = {}): string[] {
  try {
    parseConfig(text, { env });
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

describe("parseConfig", () => {
  it("fills in defaults and trims the trailing slash of URLs", () => {
    const cfg = parseConfig(minimal, { env: {} });
    expect(cfg.server).toEqual({ host: "0.0.0.0", port: 8080, bodyLimitBytes: 4 * 1024 * 1024 });
    expect(cfg.logging).toEqual({ level: "info", logBodies: false });
    expect(cfg.backends.ollama).toEqual({
      type: "ollama",
      url: "http://localhost:11434",
      timeouts: { connectMs: 5000, responseMs: 300000 },
    });
    expect(cfg.aliases).toEqual({});
    expect(cfg.limits).toEqual({});
  });

  it("parses the example configuration", () => {
    const text = readFileSync("config.example.yaml", "utf8");
    const cfg = parseConfig(text, { env: { GATEWAY_KEY_TEAM: "k1", GATEWAY_KEY_CI: "k2" } });
    expect(cfg.backends.ollama?.url).toBe("http://localhost:11434");
    expect(cfg.keys.map((k) => k.name)).toEqual(["team", "ci"]);
    expect(cfg.keys[1]?.models).toEqual(["chat-default"]);
  });

  it("reads ${VAR} and ${VAR:-default} from the environment", () => {
    const cfg = parseConfig(
      `${minimal}
server:
  port: \${PORT}
  host: \${HOST:-127.0.0.1}
logging:
  logBodies: \${LOG_BODIES}
`.replace("secret-team-key", "${TEAM_KEY}"),
      { env: { PORT: "9000", LOG_BODIES: "true", TEAM_KEY: "1234567890" } },
    );
    expect(cfg.server.port).toBe(9000);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.logging.logBodies).toBe(true);
    // An all-digit secret must stay a string.
    expect(cfg.keys[0]?.key).toBe("1234567890");
  });

  it("names every unset environment variable", () => {
    const p = problems(minimal.replace("secret-team-key", "${TEAM_KEY}").replace("http://localhost:11434/", "${URL}"));
    expect(p).toEqual([
      "backends.ollama.url: environment variable URL is not set",
      "keys[0].key: environment variable TEAM_KEY is not set",
    ]);
  });

  it("lets LLM_GATEWAY_HOST, _PORT and _LOG_LEVEL override the file", () => {
    const cfg = parseConfig(minimal, {
      env: { LLM_GATEWAY_HOST: "127.0.0.1", LLM_GATEWAY_PORT: "3000", LLM_GATEWAY_LOG_LEVEL: "debug" },
    });
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(3000);
    expect(cfg.logging.level).toBe("debug");
  });

  it("reports every invalid value with its path", () => {
    expect(
      problems(`
server:
  port: 70000
  colour: red
backends:
  ollama:
    type: llamafile
    url: ftp://example.com
keys:
  - { name: a, key: k }
`),
    ).toEqual([
      "server.port: Too big: expected number to be <=65535",
      'server: Unrecognized key: "colour"',
      'backends.ollama.type: Invalid option: expected one of "ollama"|"openai"',
      "backends.ollama.url: must start with http:// or https://",
    ]);
  });

  it("reports every broken reference and duplicate", () => {
    expect(
      problems(`
backends:
  ollama: { type: ollama, url: "http://localhost:11434" }
aliases:
  chat: { backend: missing, model: x }
keys:
  - { name: a, key: same }
  - { name: a, key: same, models: [nope] }
`),
    ).toEqual([
      'aliases.chat.backend: unknown backend "missing" (defined: ollama)',
      'keys[1].name: duplicate key name "a"',
      "keys[1].key: the same key value is used twice",
      'keys[1].models[0]: unknown alias "nope"',
    ]);
  });

  it("requires at least one backend", () => {
    const key = "keys: [{ name: a, key: k }]\n";
    expect(problems(key)).toEqual(["backends: define at least one backend"]);
    expect(problems(`backends: {}\n${key}`)).toEqual(["backends: define at least one backend"]);
  });

  it("explains YAML syntax errors with the line", () => {
    expect(problems("backends:\n  ollama: [unclosed\n")).toEqual([expect.stringMatching(/^not valid YAML at line \d+/)]);
  });

  it("rejects a top level that is not a mapping", () => {
    expect(problems("- a\n- b\n")).toEqual(["the top level must be a mapping (key: value)"]);
  });
});

describe("loadConfig", () => {
  it("reads the file named by LLM_GATEWAY_CONFIG", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-gw-"));
    const file = join(dir, "gateway.yaml");
    writeFileSync(file, minimal);
    expect(loadConfig({ env: { LLM_GATEWAY_CONFIG: file } }).keys[0]?.name).toBe("team");
  });

  it("says how to fix a missing file", () => {
    expect(() => loadConfig({ path: "does-not-exist.yaml", env: {} })).toThrow(/file not found.*config\.example\.yaml/);
  });
});
