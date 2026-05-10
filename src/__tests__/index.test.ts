import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const CLI_ENTRY = resolve(process.cwd(), "src", "index.ts");
const TSX_BINARY = resolve(process.cwd(), "node_modules", ".bin", "tsx");
const CLI_INTEGRATION_TEST_TIMEOUT_MS = 15_000;

async function createPreparedKyrosFolder(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "kyros-cli-"));
  await mkdir(resolve(root, ".kyros"), { recursive: true });
  await Promise.all([
    writeFile(resolve(root, ".kyros", "goal.md"), "# Goal\n", "utf8"),
    writeFile(resolve(root, ".kyros", "plan.md"), "# Plan\n", "utf8"),
    writeFile(resolve(root, ".kyros", "spec.md"), "# Spec\n", "utf8"),
    writeFile(resolve(root, ".kyros", "tasks.md"), "- [ ] First task\n", "utf8"),
    writeFile(
      resolve(root, ".kyros", "roles.json"),
      JSON.stringify({
        orchestrator: {
          name: "Coordinator",
          description: "Coordinates the run.",
          provider: "invalid-provider",
          model: "bad-model",
        },
        coworkers: [
          {
            name: "Builder",
            description: "Builds the work.",
            provider: "invalid-provider",
            model: "bad-model",
          },
        ],
      }, null, 2),
      "utf8",
    ),
  ]);
  return root;
}

describe("kyros CLI entrypoint", () => {
  it("auto-enters team mode when the kyros project files are present", async () => {
    const testRoot = await createPreparedKyrosFolder();

    try {
      const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "--cwd", testRoot], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unsupported provider "invalid-provider"');
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  }, CLI_INTEGRATION_TEST_TIMEOUT_MS);

  it("stays in single-agent mode when --provider is explicitly passed", async () => {
    const testRoot = await createPreparedKyrosFolder();

    try {
      const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "--cwd", testRoot, "--provider", "codex"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("A prompt is required");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("runs a named saved team with --team <name>", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-"));

    try {
      await mkdir(resolve(testRoot, ".kyros", "teams"), { recursive: true });
      await Promise.all([
        writeFile(resolve(testRoot, ".kyros", "goal.md"), "# Goal\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "plan.md"), "# Plan\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "spec.md"), "# Spec\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "tasks.md"), "- [ ] First task\n", "utf8"),
        writeFile(
          resolve(testRoot, ".kyros", "roles.json"),
          JSON.stringify({
            orchestrator: {
              name: "Default Coordinator",
              description: "Coordinates the default run.",
              provider: "codex",
              model: "gpt-5.4",
            },
            coworkers: [],
          }, null, 2),
          "utf8",
        ),
      ]);
      await writeFile(
        resolve(testRoot, ".kyros", "teams", "api.json"),
        JSON.stringify({
          orchestrator: {
            name: "API Coordinator",
            description: "Coordinates the API team.",
            provider: "codex",
            model: "gpt-5.4",
          },
          coworkers: [
            {
              name: "API Worker",
              description: "Builds the API.",
              provider: "named-invalid-provider",
              model: "bad-model",
            },
          ],
        }, null, 2),
        "utf8",
      );

      const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "--cwd", testRoot, "--team", "api"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Unsupported provider "named-invalid-provider"');
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("prints provider models as JSON for setup tooling", () => {
    const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "models", "--provider", "codex", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout) as {
      providers: Array<{ provider: string; models: Array<{ value?: string; label: string }> }>;
    };
    expect(body.providers[0]?.provider).toBe("codex");
    expect(body.providers[0]?.models.length).toBeGreaterThan(0);
  });

  it("prints the CLI version", () => {
    const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.1");
  });

  it("checks release manifest updates without npm", () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({
      version: "0.2.0",
      notesUrl: "https://github.com/bitooz/kyros-cli/releases/tag/v0.2.0",
      installer: {
        url: "https://updates.example.com/install.sh",
        args: ["--cli"],
      },
    }))}`;
    const result = spawnSync(TSX_BINARY, [CLI_ENTRY, "update", "--dry-run", "--manifest", manifest], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Update available: 0.1.1 -> 0.2.0");
    expect(result.stdout).toContain("Would run installer: https://updates.example.com/install.sh --cli");
  });

  it("installs a global MCP server for a selected provider", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "add", "docs", "--provider", "codex", "--auth", "never", "--url", "https://developers.openai.com/mcp"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Installed MCP server "docs"');

      const codexConfig = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain("[mcp_servers.docs]");
      expect(codexConfig).toContain('url = "https://developers.openai.com/mcp"');
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("accepts URL shorthand for MCP add", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "add", "docs", "https://developers.openai.com/mcp", "--provider", "codex", "--auth", "never"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      const codexConfig = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain("[mcp_servers.docs]");
      expect(codexConfig).toContain('url = "https://developers.openai.com/mcp"');
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("imports provider-style MCP JSON files", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const mcpJson = resolve(testRoot, "mcp.json");
      await writeFile(
        mcpJson,
        JSON.stringify({
          mcpServers: {
            docs: {
              url: "https://developers.openai.com/mcp",
            },
            everything: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-everything"],
            },
          },
        }, null, 2),
        "utf8",
      );

      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "import", mcpJson, "--provider", "codex", "--auth", "never"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      const codexConfig = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain("[mcp_servers.docs]");
      expect(codexConfig).toContain("[mcp_servers.everything]");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("uses the Context7 OAuth preset by default", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "add", "context7", "--provider", "codex", "--dry-run"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Would install MCP server "context7"');
      expect(result.stdout).toContain('MCP auth probe for "context7": auth required (OAuth was configured)');
      expect(result.stdout).toContain("codex mcp login context7");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("uses Context7 API key env config when requested", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "add", "context7", "--provider", "codex", "--auth", "never", "--api-key-env", "CONTEXT7_API_KEY"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      const codexConfig = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codexConfig).toContain('url = "https://mcp.context7.com/mcp"');
      expect(codexConfig).toContain('env_http_headers = { CONTEXT7_API_KEY = "CONTEXT7_API_KEY" }');
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("prints native auth commands for MCP dry-runs", () => {
    const result = spawnSync(
      TSX_BINARY,
      [CLI_ENTRY, "mcp", "auth", "docs", "--provider", "codex", "--scopes", "read,write", "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("codex mcp login docs --scopes read,write");
  });

  it("plans post-install auth when requested in a non-interactive add run", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-cli-mcp-"));

    try {
      const result = spawnSync(
        TSX_BINARY,
        [CLI_ENTRY, "mcp", "add", "docs", "--provider", "codex", "--auth", "always", "--url", "https://developers.openai.com/mcp"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: testRoot,
            XDG_CONFIG_HOME: resolve(testRoot, ".config"),
          },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Installed MCP server "docs"');
      expect(result.stdout).toContain("Auth is required, but this terminal is not interactive.");
      expect(result.stdout).toContain("codex mcp login docs");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
