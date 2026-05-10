import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { McpInstallProvider, McpServerConfig } from "./mcp-installer.js";

export type McpAuthMode = "auto" | "always" | "never";

export interface McpAuthProbeResult {
  required: boolean;
  reason: string;
  status?: number;
}

export interface AuthenticateMcpServerOptions {
  name: string;
  providers: McpInstallProvider[];
  scopes?: string[];
  dryRun?: boolean;
  plannedProviders?: McpInstallProvider[];
}

export interface McpAuthResult {
  provider: McpInstallProvider;
  status: "authenticated" | "planned" | "skipped" | "failed";
  command?: string;
  message?: string;
}

const require = createRequire(import.meta.url);
const MCP_PROTOCOL_VERSION = "2024-11-05";

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((part) => /\s/.test(part) ? shellQuote(part) : part).join(" ");
}

function hasHeaders(server: Extract<McpServerConfig, { type: "http" }>): boolean {
  return Boolean(server.bearerTokenEnvVar) ||
    Boolean(server.headers && Object.keys(server.headers).length > 0) ||
    Boolean(server.envHttpHeaders && Object.keys(server.envHttpHeaders).length > 0);
}

function isOAuthEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().includes("/oauth");
  } catch {
    return false;
  }
}

function isOAuthChallenge(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized.includes("bearer") ||
    normalized.includes("oauth") ||
    normalized.includes("authorization_uri") ||
    normalized.includes("resource_metadata");
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function authProbeFromResponse(response: Response): McpAuthProbeResult | undefined {
  const challenge = response.headers.get("www-authenticate");
  if (response.status === 401 || response.status === 403) {
    return {
      required: true,
      reason: challenge
        ? `server returned ${response.status} with WWW-Authenticate`
        : `server returned ${response.status}`,
      status: response.status,
    };
  }

  if (response.ok) {
    return {
      required: false,
      reason: `server responded ${response.status}`,
      status: response.status,
    };
  }

  if (response.status >= 400 && isOAuthChallenge(challenge)) {
    return {
      required: true,
      reason: "server returned an OAuth challenge",
      status: response.status,
    };
  }

  return undefined;
}

export async function probeMcpAuthRequirement(server: McpServerConfig): Promise<McpAuthProbeResult> {
  if (server.type !== "http") {
    return {
      required: false,
      reason: "stdio MCP servers are not probed automatically",
    };
  }

  if (server.oauth === false) {
    return {
      required: false,
      reason: "OAuth disabled for this server",
    };
  }

  if (hasHeaders(server)) {
    return {
      required: false,
      reason: "header-based auth is already configured",
    };
  }

  if (server.oauth || isOAuthEndpoint(server.url)) {
    return {
      required: true,
      reason: server.oauth ? "OAuth was configured" : "OAuth endpoint was configured",
    };
  }

  const requestBody = {
    jsonrpc: "2.0",
    id: "kyros-auth-probe",
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "kyros",
        version: "0.1.0",
      },
    },
  };

  try {
    const response = await fetchWithTimeout(server.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const result = authProbeFromResponse(response);
    if (result) {
      return result;
    }
  } catch {
    // Fall through to a lightweight GET probe.
  }

  try {
    const response = await fetchWithTimeout(server.url, {
      method: "GET",
      headers: {
        accept: "application/json, text/event-stream",
      },
    });
    const result = authProbeFromResponse(response);
    if (result) {
      return result;
    }

    return {
      required: false,
      reason: `server responded ${response.status}; auth requirement was not detected`,
      status: response.status,
    };
  } catch (error) {
    return {
      required: false,
      reason: `auth probe failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function claudeSdkCliPath(): string | undefined {
  try {
    const packagePath = require.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    return join(dirname(packagePath), "cli.js");
  } catch {
    return undefined;
  }
}

function resolveClaudeCommand(): { command: string; argsPrefix: string[] } {
  if (process.env.KYROS_CLAUDE_BIN) {
    return { command: process.env.KYROS_CLAUDE_BIN, argsPrefix: [] };
  }

  if (commandExists("claude")) {
    return { command: "claude", argsPrefix: [] };
  }

  const sdkCli = claudeSdkCliPath();
  if (sdkCli) {
    return { command: process.execPath, argsPrefix: [sdkCli] };
  }

  return { command: "claude", argsPrefix: [] };
}

function providerCommand(
  provider: McpInstallProvider,
  options: AuthenticateMcpServerOptions,
): { command: string; args: string[]; message?: string } {
  switch (provider) {
    case "codex": {
      const command = process.env.KYROS_CODEX_BIN ?? "codex";
      const args = ["mcp", "login", options.name];
      if (options.scopes?.length) {
        args.push("--scopes", options.scopes.join(","));
      }
      return { command, args };
    }
    case "opencode":
      return {
        command: process.env.KYROS_OPENCODE_BIN ?? "opencode",
        args: ["mcp", "auth", options.name],
      };
    case "claudeCode": {
      const resolved = resolveClaudeCommand();
      return {
        command: resolved.command,
        args: [...resolved.argsPrefix, "/mcp"],
        message: `Claude Code authenticates MCP servers through its /mcp menu. Select "${options.name}" when the menu opens.`,
      };
    }
  }
}

function runCommand(provider: McpInstallProvider, command: string, args: string[]): Promise<McpAuthResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve({
          provider,
          status: "skipped",
          command: formatCommand(command, args),
          message: `Command not found: ${command}`,
        });
        return;
      }

      resolve({
        provider,
        status: "failed",
        command: formatCommand(command, args),
        message: error.message,
      });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({
          provider,
          status: "authenticated",
          command: formatCommand(command, args),
        });
        return;
      }

      resolve({
        provider,
        status: "failed",
        command: formatCommand(command, args),
        message: signal ? `terminated by ${signal}` : `exited with code ${code ?? "unknown"}`,
      });
    });
  });
}

export async function authenticateMcpServer(options: AuthenticateMcpServerOptions): Promise<McpAuthResult[]> {
  const results: McpAuthResult[] = [];

  for (const provider of options.providers) {
    const { command, args, message } = providerCommand(provider, options);
    const formattedCommand = formatCommand(command, args);
    const planned = Boolean(options.dryRun || options.plannedProviders?.includes(provider));

    if (message && !planned) {
      process.stderr.write(`${message}\n`);
    }

    if (planned) {
      results.push({
        provider,
        status: "planned",
        command: formattedCommand,
        message,
      });
      continue;
    }

    results.push(await runCommand(provider, command, args));
  }

  return results;
}
