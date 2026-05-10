import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { installMcpServer, normalizeMcpServerConfig, normalizeMcpServerEntries } from "../mcp-installer.js";

describe("MCP installer", () => {
  it("installs a stdio MCP server into every provider's global config", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-mcp-"));

    try {
      const results = await installMcpServer({
        homeDir: testRoot,
        name: "everything",
        server: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          env: { CACHE_DIR: "/tmp/mcp-cache" },
        },
      });

      expect(results.map((result) => result.provider)).toEqual(["claudeCode", "codex", "opencode"]);

      const claude = JSON.parse(await readFile(resolve(testRoot, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(claude.mcpServers.everything).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: { CACHE_DIR: "/tmp/mcp-cache" },
      });

      const codex = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codex).toContain("[mcp_servers.everything]");
      expect(codex).toContain('command = "npx"');
      expect(codex).toContain('args = ["-y", "@modelcontextprotocol/server-everything"]');
      expect(codex).toContain('env = { CACHE_DIR = "/tmp/mcp-cache" }');

      const opencode = JSON.parse(
        await readFile(resolve(testRoot, ".config", "opencode", "opencode.json"), "utf8"),
      ) as {
        mcp: Record<string, unknown>;
      };
      expect(opencode.mcp.everything).toEqual({
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
        enabled: true,
        environment: { CACHE_DIR: "/tmp/mcp-cache" },
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("replaces an existing Codex server block without removing other config", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-mcp-"));

    try {
      await mkdir(resolve(testRoot, ".codex"), { recursive: true });
      await writeFile(
        resolve(testRoot, ".codex", "config.toml"),
        [
          'model = "gpt-5.4"',
          "",
          "[mcp_servers.keep]",
          'command = "keep-server"',
          "",
          "[mcp_servers.docs]",
          'command = "old-docs"',
          "",
          "[mcp_servers.docs.tools.search]",
          'approval_mode = "prompt"',
          "",
        ].join("\n"),
        "utf8",
      );

      await installMcpServer({
        homeDir: testRoot,
        providers: ["codex"],
        name: "docs",
        server: {
          type: "http",
          url: "https://developers.openai.com/mcp",
          headers: { Authorization: "Bearer test-token" },
        },
      });

      const codex = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codex).toContain('model = "gpt-5.4"');
      expect(codex).toContain("[mcp_servers.keep]");
      expect(codex).toContain("[mcp_servers.docs]");
      expect(codex).toContain('url = "https://developers.openai.com/mcp"');
      expect(codex).toContain('http_headers = { Authorization = "Bearer test-token" }');
      expect(codex).not.toContain("old-docs");
      expect(codex).not.toContain("[mcp_servers.docs.tools.search]");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("normalizes OpenCode-style MCP JSON into the shared stdio shape", () => {
    expect(normalizeMcpServerConfig({
      type: "local",
      command: ["bun", "x", "my-mcp-command"],
      environment: { API_KEY: "secret" },
    })).toEqual({
      type: "stdio",
      command: "bun",
      args: ["x", "my-mcp-command"],
      env: { API_KEY: "secret" },
    });
  });

  it("normalizes provider-style mcp.json maps", () => {
    expect(normalizeMcpServerEntries({
      mcpServers: {
        context7: {
          type: "streamable-http",
          url: "https://mcp.context7.com/mcp",
          headers: {
            CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}",
          },
        },
      },
    })).toEqual([{
      name: "context7",
      server: {
        type: "http",
        url: "https://mcp.context7.com/mcp",
        envHttpHeaders: {
          CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
        },
      },
    }]);
  });

  it("selects one server from OpenCode-style MCP JSON", () => {
    expect(normalizeMcpServerEntries({
      mcp: {
        docs: {
          type: "remote",
          url: "https://developers.openai.com/mcp",
          enabled: true,
        },
        everything: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
        },
      },
    }, { name: "everything" })).toEqual([{
      name: "everything",
      server: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    }]);
  });

  it("writes provider-specific auth configuration for remote servers", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-mcp-"));

    try {
      await installMcpServer({
        homeDir: testRoot,
        name: "github",
        server: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          bearerTokenEnvVar: "GITHUB_TOKEN",
          oauth: {
            scopes: "repo read:user",
            callbackPort: 8080,
          },
          oauthResource: "https://api.githubcopilot.com/",
        },
      });

      const codex = await readFile(resolve(testRoot, ".codex", "config.toml"), "utf8");
      expect(codex).toContain("mcp_oauth_callback_port = 8080");
      expect(codex).toContain('bearer_token_env_var = "GITHUB_TOKEN"');
      expect(codex).toContain('oauth_resource = "https://api.githubcopilot.com/"');
      expect(codex).toContain('scopes = ["repo", "read:user"]');

      const claude = JSON.parse(await readFile(resolve(testRoot, ".claude.json"), "utf8")) as {
        mcpServers: Record<string, { headersHelper?: string; oauth?: Record<string, unknown> }>;
      };
      expect(claude.mcpServers.github?.headersHelper).toContain("GITHUB_TOKEN");
      expect(claude.mcpServers.github?.oauth).toEqual({
        callbackPort: 8080,
        scopes: "repo read:user",
      });

      const opencode = JSON.parse(
        await readFile(resolve(testRoot, ".config", "opencode", "opencode.json"), "utf8"),
      ) as {
        mcp: Record<string, { headers?: Record<string, string>; oauth?: Record<string, unknown> }>;
      };
      expect(opencode.mcp.github?.headers?.Authorization).toBe("Bearer {env:GITHUB_TOKEN}");
      expect(opencode.mcp.github?.oauth).toEqual({
        scope: "repo read:user",
      });
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
