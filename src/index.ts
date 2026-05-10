#!/usr/bin/env node

import { getAdapter, listAdapters, registerBuiltinAdapters, type AdapterEvent, type AdapterModelOption, type AdapterPermissionMode, type AdapterProvider, type AdapterQuestionMode, type AdapterRunMode, type AdapterSessionConfig, type PermissionRequest, type QuestionAnswer, type QuestionRequest } from "./adapters/index.js";
import { ClaudePrettyRenderer } from "./claude-pretty.js";
import { shouldRunTeamMode } from "./launch-mode.js";
import { runTeamPrototype } from "./team/runtime.js";
import { hasProjectTeamContext, listTeamDefinitions, resolveGlobalTeamsDirectory, resolveTeamsDirectory } from "./team/storage.js";
import { runTeamTui } from "./team/tui.js";
import { authenticateMcpServer, probeMcpAuthRequirement, type McpAuthMode, type McpAuthProbeResult, type McpAuthResult } from "./mcp-auth.js";
import { installMcpServer, MCP_INSTALL_PROVIDERS, normalizeMcpServerEntries, parseMcpJson, type McpInstallProvider, type McpInstallResult, type McpOAuthConfig, type McpServerConfig, type McpServerEntry } from "./mcp-installer.js";
import { runTui } from "./tui.js";
import { getPackageInfo, maybeNotifyUpdate, runUpdateCommand, shouldRunStartupUpdateCheck, type UpdateCommandOptions } from "./updater.js";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr, exit } from "node:process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { inspect } from "node:util";

interface CliOptions {
  chat: boolean;
  team: boolean;
  teamName?: string;
  teamModels: string[];
  teamMemberModels: string[];
  listTeams?: boolean;
  listModels?: boolean;
  update?: UpdateCliOptions;
  version?: boolean;
  mcp?: McpCliOptions;
  json?: boolean;
  refreshModels?: boolean;
  provider: AdapterProvider;
  cwd: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  permissionMode: AdapterPermissionMode;
  runMode: AdapterRunMode;
  questionMode: AdapterQuestionMode;
  outputMode: CliOutputMode;
}

type CliOutputMode = "tui" | "pretty" | "raw";

type UpdateCliOptions = UpdateCommandOptions & {
  help?: boolean;
};

interface McpCliOptions {
  command: "add" | "auth";
  name?: string;
  providers: McpInstallProvider[];
  server?: McpServerConfig;
  entries?: McpServerEntry[];
  scopes?: string[];
  authMode: McpAuthMode;
  dryRun: boolean;
  help?: boolean;
}

const HELP = `
kyros CLI

Usage:
  kyros                  Open Kyros for this folder
  kyros team             Run the project team
  kyros --team api
                         Run the saved api team
  kyros teams            List global and local saved teams
  kyros models --json    List harness models for roles.json
  kyros update           Update the installed Kyros CLI
  kyros update --check   Check the release manifest for a newer Kyros CLI version
  kyros mcp add <name> --url <url>
                         Install a global MCP server for every provider
  kyros mcp add <name> -- <command> [args...]
                         Install a global stdio MCP server

Options:
  --cwd <path>       Run Kyros in another folder
  --model <model>    Use a specific model
  --provider <name>  Select claudeCode, codex, or opencode
  --version          Print the CLI version
  --help             Show this help

Examples:
  kyros
  kyros team "ship the next milestone"
  kyros --team api
  kyros --cwd ~/code/app --team api
`.trim();

const UPDATE_HELP = `
kyros updater

Usage:
  kyros update
  kyros update --check
  kyros update --dry-run

Options:
  --check              Check for a newer version without installing
  --dry-run            Print the installer that would run
  --manifest <url>     Override the update manifest URL
  --help               Show this help

Environment:
  KYROS_UPDATE_MANIFEST_URL can override the default GitHub Releases manifest.
`.trim();

const MCP_HELP = `
kyros MCP installer

Usage:
  kyros mcp add context7
  kyros mcp add <name> <url>
  kyros mcp add <name> <mcp.json>
  kyros mcp import <mcp.json>
  kyros mcp add <name> --json '<server-json>' [--provider <name>]
  kyros mcp add <name> [--env KEY=VALUE] -- <command> [args...]
  kyros mcp auth <name> [--provider all|codex|claudeCode|opencode]

Options:
  --provider <name>  Target all, codex, claudeCode, or opencode (default: all)
  --providers <csv>  Target a comma-separated provider list
  --url <url>        Install a remote streamable HTTP MCP server
  --json <json>      Install from a server object or mcpServers/mcp JSON
  --file <path>      Install from a provider-style mcp.json file
  --bearer-env <var> Source an HTTP bearer token from an environment variable
  --api-key-env <var>
                     Source a Context7 API key from the environment
  --env KEY=VALUE    Add an environment variable for stdio servers
  --header K=V       Add an HTTP header for remote servers
  --header-env K=V   Source an HTTP header value from an environment variable
  --oauth-scopes <s> Restrict OAuth scopes for providers that support it
  --oauth-client-id <id>
                     Configure a pre-registered OAuth client
  --oauth-client-secret-env <var>
                     Source OAuth client secret from an environment variable
  --oauth-resource <resource>
                     Configure Codex RFC 8707 OAuth resource
  --callback-port <port>
                     Use a fixed OAuth callback port where supported
  --auth-server-metadata-url <url>
                     Override Claude Code OAuth metadata discovery
  --no-oauth         Disable automatic OAuth detection for API-key servers
  --auth <mode>      After add: auto, always, or never (default: auto)
  --dry-run          Print target config paths without writing

Examples:
  kyros mcp add context7
  kyros mcp add sentry https://mcp.sentry.dev/mcp
  kyros mcp import .mcp.json
  kyros mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-env GITHUB_TOKEN
  kyros mcp add everything -- npx -y @modelcontextprotocol/server-everything
`.trim();

function isProvider(value: string | undefined): value is AdapterProvider {
  return value === "claudeCode" || value === "codex" || value === "opencode";
}

function parseProviderTarget(value: string): McpInstallProvider[] {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  if (lower === "all") {
    return [...MCP_INSTALL_PROVIDERS];
  }
  if (lower === "claude" || lower === "claudecode" || lower === "claude-code" || lower === "claude_code") {
    return ["claudeCode"];
  }
  if (lower === "opencode" || lower === "open-code" || lower === "open_code") {
    return ["opencode"];
  }
  if (lower === "codex") {
    return ["codex"];
  }
  throw new Error(`Invalid MCP provider "${value}". Expected all, claudeCode, codex, or opencode.`);
}

function addProviderTargets(
  current: McpInstallProvider[] | undefined,
  raw: string,
): McpInstallProvider[] {
  const targets = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap(parseProviderTarget);
  const merged = current ? [...current, ...targets] : targets;
  return MCP_INSTALL_PROVIDERS.filter((provider) => merged.includes(provider));
}

function parseKeyValue(raw: string, flag: string): [string, string] {
  const separator = raw.indexOf("=");
  if (separator <= 0) {
    throw new Error(`Invalid ${flag} "${raw}". Expected KEY=VALUE.`);
  }

  const key = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1);
  if (!key) {
    throw new Error(`Invalid ${flag} "${raw}". Key cannot be empty.`);
  }
  return [key, value];
}

function requireHttpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid MCP URL "${raw}".`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid MCP URL "${raw}". Expected http or https.`);
  }

  return raw;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${flag} "${raw}". Expected a positive integer.`);
  }
  return value;
}

function parseScopes(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function validateEnvVarName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name "${name}".`);
  }
  return name;
}

function parseAuthMode(value: string): McpAuthMode {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  throw new Error(`Invalid --auth "${value}". Expected auto, always, or never.`);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function readJsonSource(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return parseMcpJson(trimmed);
  }

  const path = resolve(raw);
  if (!existsSync(path)) {
    throw new Error(`MCP JSON file not found: ${raw}`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`MCP JSON path is not a file: ${raw}`);
  }
  return parseMcpJson(readFileSync(path, "utf8"));
}

function hasHttpAuthConfig(server: Extract<McpServerConfig, { type: "http" }>): boolean {
  return Boolean(server.bearerTokenEnvVar) ||
    Boolean(server.headers && Object.keys(server.headers).length > 0) ||
    Boolean(server.envHttpHeaders && Object.keys(server.envHttpHeaders).length > 0);
}

function isContext7Server(name: string, server?: McpServerConfig): boolean {
  if (name.toLowerCase() === "context7") {
    return true;
  }
  if (server?.type !== "http") {
    return false;
  }
  try {
    return new URL(server.url).hostname === "mcp.context7.com";
  } catch {
    return false;
  }
}

function withKnownMcpDefaults(name: string, server: McpServerConfig): McpServerConfig {
  if (!isContext7Server(name, server) || server.type !== "http" || server.oauth === false || hasHttpAuthConfig(server)) {
    return server;
  }

  let url = server.url;
  try {
    const parsed = new URL(server.url);
    if (parsed.hostname === "mcp.context7.com" && parsed.pathname === "/mcp") {
      parsed.pathname = "/mcp/oauth";
      url = parsed.toString();
    }
  } catch {
    return server;
  }

  return {
    ...server,
    url,
    oauth: server.oauth ?? {},
  };
}

function knownMcpPreset(name: string): McpServerConfig | undefined {
  if (name.toLowerCase() !== "context7") {
    return undefined;
  }

  return {
    type: "http",
    url: "https://mcp.context7.com/mcp/oauth",
    oauth: {},
  };
}

function context7ApiKeyServer(): Extract<McpServerConfig, { type: "http" }> {
  return {
    type: "http",
    url: "https://mcp.context7.com/mcp",
    envHttpHeaders: {
      CONTEXT7_API_KEY: "CONTEXT7_API_KEY",
    },
    oauth: false,
  };
}

function mergeMcpCliExtras(
  server: McpServerConfig,
  env: Record<string, string>,
  headers: Record<string, string>,
  envHttpHeaders: Record<string, string>,
  auth: {
    bearerTokenEnvVar?: string;
    oauth?: false | McpOAuthConfig;
    oauthResource?: string;
  },
): McpServerConfig {
  if (server.type === "stdio") {
    return {
      ...server,
      ...(Object.keys(env).length
        ? { env: { ...(server.env ?? {}), ...env } }
        : {}),
    };
  }

  return {
    ...server,
    ...(Object.keys(headers).length
      ? { headers: { ...(server.headers ?? {}), ...headers } }
      : {}),
    ...(Object.keys(envHttpHeaders).length
      ? { envHttpHeaders: { ...(server.envHttpHeaders ?? {}), ...envHttpHeaders } }
      : {}),
    ...(auth.bearerTokenEnvVar ? { bearerTokenEnvVar: auth.bearerTokenEnvVar } : {}),
    ...(auth.oauth !== undefined ? { oauth: auth.oauth } : {}),
    ...(auth.oauthResource ? { oauthResource: auth.oauthResource } : {}),
  };
}

function parseMcpArgs(argv: string[]): McpCliOptions {
  const [rawCommand, rawName, ...rest] = argv;
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h" || rawCommand === "help") {
    return {
      command: "add",
      providers: [...MCP_INSTALL_PROVIDERS],
      authMode: "auto",
      dryRun: false,
      help: true,
    };
  }

  if (rawCommand !== "add" && rawCommand !== "install" && rawCommand !== "import" && rawCommand !== "auth" && rawCommand !== "login") {
    throw new Error(`Unsupported mcp command "${rawCommand}". Use "add", "import", or "auth".`);
  }

  if (!rawName || rawName.startsWith("--")) {
    throw new Error(rawCommand === "import" ? "Missing MCP JSON file." : "Missing MCP server name.");
  }

  let providers: McpInstallProvider[] | undefined;
  let url: string | undefined;
  let rawJson: string | undefined;
  let rawFile: string | undefined;
  let commandArgs: string[] | undefined;
  const bareSources: string[] = [];
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const envHttpHeaders: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;
  let apiKeyEnvVar: string | undefined;
  let oauthConfig: McpOAuthConfig | undefined;
  let oauthDisabled = false;
  let oauthResource: string | undefined;
  let scopes: string[] | undefined;
  let authMode: McpAuthMode = "auto";
  let dryRun = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      commandArgs = rest.slice(index + 1);
      break;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        command: rawCommand === "auth" || rawCommand === "login" ? "auth" : "add",
        name: rawName,
        providers: providers ?? [...MCP_INSTALL_PROVIDERS],
        scopes,
        authMode,
        dryRun,
        help: true,
      };
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--no-oauth") {
      oauthDisabled = true;
      continue;
    }

    if (arg === "--no-auth") {
      authMode = "never";
      continue;
    }

    if (!arg.startsWith("--")) {
      bareSources.push(arg);
      continue;
    }

    const next = rest[index + 1];
    if (next == null) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--provider":
      case "--providers":
        providers = addProviderTargets(providers, next);
        index += 1;
        break;
      case "--url":
        url = requireHttpUrl(next);
        index += 1;
        break;
      case "--json":
        rawJson = next;
        index += 1;
        break;
      case "--file":
      case "--from":
        rawFile = next;
        index += 1;
        break;
      case "--env": {
        const [key, value] = parseKeyValue(next, "--env");
        env[key] = value;
        index += 1;
        break;
      }
      case "--header": {
        const [key, value] = parseKeyValue(next, "--header");
        headers[key] = value;
        index += 1;
        break;
      }
      case "--header-env": {
        const [key, value] = parseKeyValue(next, "--header-env");
        envHttpHeaders[key] = validateEnvVarName(value);
        index += 1;
        break;
      }
      case "--bearer-env":
        bearerTokenEnvVar = validateEnvVarName(next);
        index += 1;
        break;
      case "--api-key-env":
      case "--key-env":
        apiKeyEnvVar = validateEnvVarName(next);
        index += 1;
        break;
      case "--oauth-scopes":
      case "--oauth-scope":
      case "--scopes":
        scopes = parseScopes(next);
        oauthConfig = {
          ...(oauthConfig ?? {}),
          scopes: scopes.join(" "),
        };
        index += 1;
        break;
      case "--oauth-client-id":
        oauthConfig = {
          ...(oauthConfig ?? {}),
          clientId: next,
        };
        index += 1;
        break;
      case "--oauth-client-secret-env":
        oauthConfig = {
          ...(oauthConfig ?? {}),
          clientSecretEnvVar: validateEnvVarName(next),
        };
        index += 1;
        break;
      case "--oauth-resource":
        oauthResource = next;
        index += 1;
        break;
      case "--callback-port":
        oauthConfig = {
          ...(oauthConfig ?? {}),
          callbackPort: parsePositiveInteger(next, "--callback-port"),
        };
        index += 1;
        break;
      case "--auth-server-metadata-url":
        oauthConfig = {
          ...(oauthConfig ?? {}),
          authServerMetadataUrl: requireHttpUrl(next),
        };
        index += 1;
        break;
      case "--auth":
        authMode = parseAuthMode(next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown mcp argument "${arg}"`);
    }
  }

  if (rawCommand === "auth" || rawCommand === "login") {
    return {
      command: "auth",
      name: rawName,
      providers: providers ?? [...MCP_INSTALL_PROVIDERS],
      scopes,
      authMode: "always",
      dryRun,
    };
  }

  if (rawCommand === "import") {
    if (bareSources.length > 0 || rawJson || url || commandArgs?.length) {
      throw new Error("Use one MCP JSON source with import: kyros mcp import <mcp.json>.");
    }

    const entries = normalizeMcpServerEntries(readJsonSource(rawFile ?? rawName))
      .map((entry) => ({
        name: entry.name,
        server: withKnownMcpDefaults(entry.name, mergeMcpCliExtras(entry.server, env, headers, envHttpHeaders, {
          ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
          ...(oauthDisabled ? { oauth: false as const } : (oauthConfig !== undefined ? { oauth: oauthConfig } : {})),
          ...(oauthResource ? { oauthResource } : {}),
        })),
      }));

    return {
      command: "add",
      providers: providers ?? [...MCP_INSTALL_PROVIDERS],
      entries,
      scopes,
      authMode,
      dryRun,
    };
  }

  if (bareSources.length > 1) {
    throw new Error("Provide only one MCP URL or JSON file.");
  }

  if (bareSources[0]) {
    if (isHttpUrl(bareSources[0])) {
      url = requireHttpUrl(bareSources[0]);
    } else {
      rawFile = bareSources[0];
    }
  }

  if ([Boolean(rawJson), Boolean(rawFile), Boolean(url), Boolean(commandArgs?.length)].filter(Boolean).length > 1) {
    throw new Error("Provide exactly one MCP server source: a URL, --json, --file, or a command after --.");
  }

  let entries: McpServerEntry[];
  if (rawJson || rawFile) {
    entries = normalizeMcpServerEntries(readJsonSource(rawJson ?? rawFile!), { name: rawName });
  } else if (url) {
    entries = [{
      name: rawName,
      server: {
      type: "http",
      url,
      ...(Object.keys(headers).length ? { headers } : {}),
      },
    }];
  } else {
    const [command, ...args] = commandArgs ?? [];
    if (command) {
      entries = [{
        name: rawName,
        server: {
          type: "stdio",
          command,
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        },
      }];
    } else {
      const preset = knownMcpPreset(rawName);
      if (!preset) {
        throw new Error("Provide an MCP URL, JSON file, or stdio command. Example: kyros mcp add context7");
      }
      entries = [{
        name: rawName,
        server: preset,
      }];
    }
  }

  const oauth = oauthDisabled ? false : oauthConfig;
  entries = entries.map((entry) => {
    let server: McpServerConfig = mergeMcpCliExtras(entry.server, env, headers, envHttpHeaders, {
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...(oauthResource ? { oauthResource } : {}),
    });

    if (apiKeyEnvVar) {
      if (!isContext7Server(entry.name, server)) {
        throw new Error("--api-key-env is only available for known MCP presets. Use --header-env HEADER=ENV_VAR for custom servers.");
      }
      server = {
        ...context7ApiKeyServer(),
        envHttpHeaders: {
          CONTEXT7_API_KEY: apiKeyEnvVar,
        },
      };
    }

    return {
      name: entry.name,
      server: withKnownMcpDefaults(entry.name, server),
    };
  });

  return {
    command: "add",
    name: entries.length === 1 ? entries[0]?.name : undefined,
    providers: providers ?? [...MCP_INSTALL_PROVIDERS],
    server: entries.length === 1 ? entries[0]?.server : undefined,
    entries,
    scopes,
    authMode,
    dryRun,
  };
}

function parseUpdateArgs(argv: string[]): UpdateCliOptions {
  const options: UpdateCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h" || arg === "help") {
      options.help = true;
      continue;
    }

    if (arg === "--check") {
      options.checkOnly = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const next = argv[index + 1];
    if (next == null) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--manifest":
      case "--manifest-url":
        options.manifestUrl = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown update argument "${arg}"`);
    }
  }

  return options;
}

function isPermissionMode(value: string | undefined): value is AdapterPermissionMode {
  return value === "auto" || value === "interactive" || value === "bypass";
}

function isRunMode(value: string | undefined): value is AdapterRunMode {
  return value === "execute" || value === "plan";
}

function isQuestionMode(value: string | undefined): value is AdapterQuestionMode {
  return value === "auto" || value === "required" || value === "disabled";
}

function isOutputMode(value: string | undefined): value is CliOutputMode {
  return value === "tui" || value === "pretty" || value === "raw";
}

function classifyCommand(parsed: ReturnType<typeof parseArgs>): string {
  if (parsed.help) {
    return "help";
  }
  if (parsed.version) {
    return "version";
  }
  if (parsed.update) {
    return "update";
  }
  if (parsed.mcp) {
    return "mcp";
  }
  if (parsed.listTeams) {
    return "teams";
  }
  if (parsed.listModels) {
    return "models";
  }
  if (parsed.chat) {
    return "chat";
  }
  if (parsed.team) {
    return "team";
  }
  return parsed.prompt ? "task" : "open";
}

function parseArgs(argv: string[]): Omit<CliOptions, "prompt"> & {
  prompt?: string;
  help?: boolean;
} {
  const options: Omit<CliOptions, "prompt"> & {
    prompt?: string;
    help?: boolean;
  } = {
    chat: false,
    team: false,
    teamName: undefined,
    teamModels: [],
    teamMemberModels: [],
    listTeams: false,
    provider: "claudeCode",
    cwd: process.cwd(),
    permissionMode: "auto",
    runMode: "execute",
    questionMode: "auto",
    outputMode: "raw",
  };

  const positional: string[] = [];

  const command = argv[0];
  if (command === "chat") {
    options.chat = true;
    argv = argv.slice(1);
  } else if (command === "update" || command === "upgrade") {
    options.update = parseUpdateArgs(argv.slice(1));
    argv = [];
  } else if (command === "mcp") {
    options.mcp = parseMcpArgs(argv.slice(1));
    argv = [];
  } else if (command === "team") {
    options.team = true;
    argv = argv.slice(1);
  } else if (command === "teams") {
    options.listTeams = true;
    argv = argv.slice(1);
  } else if (command === "models") {
    options.listModels = true;
    argv = argv.slice(1);
  } else if (command === "help") {
    options.help = true;
    argv = argv.slice(1);
  } else if (command === "version") {
    options.version = true;
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      options.version = true;
      continue;
    }

    if (arg === "--team") {
      options.team = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        options.teamName = next;
        i += 1;
      }
      continue;
    }

    if (arg === "--teams") {
      options.listTeams = true;
      continue;
    }

    if (arg === "--models") {
      options.listModels = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--refresh-models") {
      options.refreshModels = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const next = argv[i + 1];
    if (next == null) {
      throw new Error(`Missing value for ${arg}`);
    }

    switch (arg) {
      case "--provider":
        if (!isProvider(next)) {
          throw new Error(`Invalid provider "${next}"`);
        }
        options.provider = next;
        i += 1;
        break;
      case "--prompt":
        options.prompt = next;
        i += 1;
        break;
      case "--team-name":
        options.teamName = next;
        i += 1;
        break;
      case "--team-model":
        options.teamModels.push(next);
        i += 1;
        break;
      case "--team-member-model":
        options.teamMemberModels.push(next);
        i += 1;
        break;
      case "--model":
        options.model = next;
        i += 1;
        break;
      case "--cwd":
        options.cwd = resolve(next);
        i += 1;
        break;
      case "--system-prompt":
        options.systemPrompt = next;
        i += 1;
        break;
      case "--permission-mode":
        if (!isPermissionMode(next)) {
          throw new Error(`Invalid permission mode "${next}"`);
        }
        options.permissionMode = next;
        i += 1;
        break;
      case "--run-mode":
        if (!isRunMode(next)) {
          throw new Error(`Invalid run mode "${next}"`);
        }
        options.runMode = next;
        i += 1;
        break;
      case "--question-mode":
        if (!isQuestionMode(next)) {
          throw new Error(`Invalid question mode "${next}"`);
        }
        options.questionMode = next;
        i += 1;
        break;
      case "--output":
        if (!isOutputMode(next)) {
          throw new Error(`Invalid output mode "${next}"`);
        }
        options.outputMode = next;
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }

  if (!options.prompt && positional.length > 0) {
    options.prompt = positional.join(" ");
  }

  return options;
}

async function readPromptFromStdin(): Promise<string | undefined> {
  if (input.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text || undefined;
}

function printHeader(options: CliOptions): void {
  output.write(`provider: ${options.provider}\n`);
  output.write(`cwd: ${options.cwd}\n`);
  output.write(`run mode: ${options.runMode}\n`);
  output.write(`permission mode: ${options.permissionMode}\n`);
  output.write(`question mode: ${options.questionMode}\n`);
  if (options.model) {
    output.write(`model: ${options.model}\n`);
  }
  output.write(`output mode: ${options.outputMode}\n`);
  output.write("\n");
}

interface ProviderModelsResult {
  provider: AdapterProvider;
  models: AdapterModelOption[];
  error?: string;
}

async function listProviderModels(options: {
  provider?: AdapterProvider;
  cwd: string;
}): Promise<ProviderModelsResult[]> {
  registerBuiltinAdapters();
  const providers = options.provider ? [options.provider] : listAdapters();

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const models = await getAdapter(provider).listModels?.({ cwd: options.cwd });
      return {
        provider,
        models: models ?? [],
      };
    }),
  );

  return results.map((result, index) => {
    const provider = providers[index]!;
    if (result.status === "fulfilled") {
      return result.value;
    }

    const error = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);
    return {
      provider,
      models: [],
      error,
    };
  });
}

function printProviderModels(results: ProviderModelsResult[]): void {
  for (const result of results) {
    output.write(`${result.provider}\n`);

    if (result.error) {
      output.write(`  error: ${result.error}\n`);
      continue;
    }

    if (result.models.length === 0) {
      output.write("  no models returned\n");
      continue;
    }

    for (const model of result.models) {
      const value = model.value ?? "default";
      const label = model.label && model.label !== value ? ` (${model.label})` : "";
      output.write(`  - ${value}${label}\n`);
      if (model.description) {
        output.write(`    ${model.description}\n`);
      }
    }
  }
}

function printMcpInstallResults(
  name: string,
  results: McpInstallResult[],
  dryRun: boolean,
  showRestartHint = true,
): void {
  output.write(`${dryRun ? "Would install" : "Installed"} MCP server "${name}":\n`);
  for (const result of results) {
    output.write(`- ${result.provider}\t${result.path}\n`);
  }
  if (!dryRun && showRestartHint) {
    output.write("\nRestart any open provider sessions so they reload MCP configuration.\n");
  }
}

function printMcpAuthResults(results: McpAuthResult[]): void {
  output.write("MCP auth results:\n");
  for (const result of results) {
    output.write(`- ${result.provider}\t${result.status}`);
    if (result.command) {
      output.write(`\t${result.command}`);
    }
    if (result.message) {
      output.write(`\t${result.message}`);
    }
    output.write("\n");
  }
}

function printMcpAuthProbe(name: string, probe: McpAuthProbeResult): void {
  output.write(`MCP auth probe for "${name}": ${probe.required ? "auth required" : "auth not required"} (${probe.reason})\n`);
}

async function maybeAuthenticateAfterInstall(options: {
  name: string;
  providers: McpInstallProvider[];
  server: McpServerConfig;
  scopes?: string[];
  authMode: McpAuthMode;
  installDryRun: boolean;
}): Promise<void> {
  if (options.authMode === "never") {
    return;
  }

  const probe = options.authMode === "always"
    ? { required: true, reason: "--auth always" }
    : await probeMcpAuthRequirement(options.server);

  if (options.authMode === "auto") {
    printMcpAuthProbe(options.name, probe);
  }

  if (!probe.required) {
    return;
  }

  const interactive = Boolean(input.isTTY && output.isTTY);
  const multipleProviders = options.providers.length > 1;
  const planAuth = options.installDryRun || !interactive || (options.authMode === "auto" && multipleProviders);
  const plannedProviders = options.authMode === "auto" && options.providers.includes("claudeCode")
    ? ["claudeCode" as const]
    : [];

  if (!interactive && !options.installDryRun) {
    output.write("Auth is required, but this terminal is not interactive. Showing the command(s) to run later.\n");
  } else if (options.authMode === "auto" && multipleProviders && !options.installDryRun) {
    output.write("Auth is required. This install targets multiple providers, so Kyros will not open every provider UI automatically.\n");
  } else if (plannedProviders.length > 0 && !options.installDryRun) {
    output.write("Auth is required. Claude Code authentication happens inside its /mcp menu, so Kyros will not open Claude Code automatically.\n");
  }

  const authResults = await authenticateMcpServer({
    name: options.name,
    providers: options.providers,
    scopes: options.scopes,
    dryRun: planAuth,
    plannedProviders,
  });
  printMcpAuthResults(authResults);
}

async function askPermission(
  rl: ReturnType<typeof createInterface>,
  request: PermissionRequest,
): Promise<"allow" | "deny"> {
  output.write("\n[permission request]\n");
  output.write(`tool: ${request.tool}\n`);
  if (request.description) {
    output.write(`description: ${request.description}\n`);
  }
  if (request.path) {
    output.write(`path: ${request.path}\n`);
  }
  output.write(`input: ${JSON.stringify(request.input, null, 2)}\n`);

  const raw = (await rl.question("allow? [y/N] ")).trim().toLowerCase();
  return raw === "y" || raw === "yes" ? "allow" : "deny";
}

function parseQuestionAnswer(raw: string, request: QuestionRequest["questions"][number]): string | string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return request.multiSelect ? [] : "";
  }

  if (request.multiSelect) {
    const parts = trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    const selected = parts.flatMap((part) => {
      const index = Number.parseInt(part, 10);
      if (!Number.isNaN(index) && index >= 1 && index <= request.options.length) {
        return [request.options[index - 1]!.label];
      }
      return [];
    });

    return selected.length === parts.length && selected.length > 0
      ? selected
      : parts;
  }

  const index = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(index) && index >= 1 && index <= request.options.length) {
    return request.options[index - 1]!.label;
  }

  return trimmed;
}

async function askQuestions(
  rl: ReturnType<typeof createInterface>,
  request: QuestionRequest,
): Promise<QuestionAnswer> {
  output.write("\n[question request]\n");

  const answers: Record<string, string | string[]> = {};

  for (const question of request.questions) {
    output.write(`\n${question.header}: ${question.question}\n`);
    question.options.forEach((option, index) => {
      output.write(`  ${index + 1}. ${option.label} — ${option.description}\n`);
    });

    const prompt = question.multiSelect
      ? "select one or more options (comma-separated numbers) or type your own answer: "
      : "select an option number or type your own answer: ";

    const raw = await rl.question(prompt);
    answers[question.id] = parseQuestionAnswer(raw, question);
  }

  output.write("\n");
  return { answers };
}

function formatUsage(event: AdapterEvent & { type: "completed" }): string {
  const { usage } = event.result;
  return `input=${usage.inputTokens} output=${usage.outputTokens} cost=${usage.costUsd ?? 0}`;
}

function formatValue(value: unknown): string {
  return inspect(value, {
    depth: null,
    colors: false,
    compact: false,
    breakLength: 120,
    maxArrayLength: null,
    maxStringLength: null,
  });
}

function writeEventLine(prefix: string, message: string, state: { textOpen: boolean }): void {
  if (state.textOpen) {
    output.write("\n");
    state.textOpen = false;
  }
  output.write(`[${prefix}] ${message}\n`);
}

function writeEventBlock(prefix: string, message: string, state: { textOpen: boolean }): void {
  if (state.textOpen) {
    output.write("\n");
    state.textOpen = false;
  }

  const [firstLine = "", ...rest] = message.split("\n");
  output.write(`[${prefix}] ${firstLine}\n`);

  for (const line of rest) {
    output.write(`  ${line}\n`);
  }
}

function handleStreamEvent(
  event: AdapterEvent,
  state: { textOpen: boolean },
  options: { showProviderEvents: boolean },
): void {
  switch (event.type) {
    case "session.started":
      writeEventLine("session", `${event.provider} ${event.sessionId ?? "(pending id)"}`, state);
      break;
    case "status":
      if (event.data === undefined) {
        writeEventLine(event.category, event.message, state);
      } else {
        writeEventBlock(event.category, `${event.message}\n${formatValue(event.data)}`, state);
      }
      break;
    case "provider.event":
      if (options.showProviderEvents) {
        writeEventBlock(
          `raw ${event.provider}:${event.eventType}`,
          formatValue(event.data),
          state,
        );
      }
      break;
    case "text.delta":
      output.write(event.text);
      state.textOpen = true;
      break;
    case "message.completed":
      break;
    case "thinking":
      writeEventLine("thinking", event.text, state);
      break;
    case "tool.use":
      writeEventBlock("tool", `${event.tool}\n${formatValue(event.input)}`, state);
      break;
    case "tool.result":
      writeEventBlock("tool-result", `${event.tool}\n${formatValue(event.output)}`, state);
      break;
    case "command":
      writeEventBlock(
        "command",
        `${event.command} (exit ${event.exitCode})${event.output ? `\n${event.output}` : ""}`,
        state,
      );
      break;
    case "file.change":
      writeEventLine("file", `${event.kind} ${event.path}`, state);
      break;
    case "permission.request":
      writeEventBlock("permission", formatValue(event.request), state);
      break;
    case "question":
      writeEventBlock("question", formatValue(event.request), state);
      break;
    case "error":
      writeEventLine("error", event.error, state);
      break;
    case "completed":
      writeEventLine("done", formatUsage(event), state);
      break;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (shouldRunStartupUpdateCheck({
    argv: process.argv.slice(2),
    stdinIsTTY: Boolean(input.isTTY),
    stderrIsTTY: Boolean(stderr.isTTY),
  })) {
    await maybeNotifyUpdate();
  }

  if (parsed.help) {
    output.write(`${HELP}\n`);
    return;
  }

  if (parsed.version) {
    output.write(`${getPackageInfo().version}\n`);
    return;
  }

  if (parsed.update) {
    if (parsed.update.help) {
      output.write(`${UPDATE_HELP}\n`);
      return;
    }

    await runUpdateCommand(parsed.update);
    return;
  }

  if (parsed.mcp) {
    if (parsed.mcp.help) {
      output.write(`${MCP_HELP}\n`);
      return;
    }

    if (parsed.mcp.command === "auth") {
      if (!parsed.mcp.name) {
        throw new Error("Missing MCP server name.");
      }

      const results = await authenticateMcpServer({
        name: parsed.mcp.name,
        providers: parsed.mcp.providers,
        scopes: parsed.mcp.scopes,
        dryRun: parsed.mcp.dryRun,
      });
      printMcpAuthResults(results);
      return;
    }

    const entries = parsed.mcp.entries ?? (parsed.mcp.name && parsed.mcp.server
      ? [{ name: parsed.mcp.name, server: parsed.mcp.server }]
      : []);
    if (entries.length === 0) {
      throw new Error("Missing MCP server configuration.");
    }

    for (const entry of entries) {
      const results = await installMcpServer({
        name: entry.name,
        server: entry.server,
        providers: parsed.mcp.providers,
        dryRun: parsed.mcp.dryRun,
      });
      printMcpInstallResults(entry.name, results, parsed.mcp.dryRun, entries.length === 1);
      await maybeAuthenticateAfterInstall({
        name: entry.name,
        providers: parsed.mcp.providers,
        server: entry.server,
        scopes: parsed.mcp.scopes,
        authMode: parsed.mcp.authMode,
        installDryRun: parsed.mcp.dryRun,
      });
    }
    if (entries.length > 1 && !parsed.mcp.dryRun) {
      output.write("\nRestart any open provider sessions so they reload MCP configuration.\n");
    }
    return;
  }

  if (parsed.listTeams) {
    const teams = await listTeamDefinitions(parsed.cwd);
    if (teams.length === 0) {
      output.write(`No saved teams found in ${resolveTeamsDirectory(parsed.cwd)} or ${resolveGlobalTeamsDirectory()}.\n`);
      return;
    }

    output.write("Saved teams:\n");
    for (const team of teams) {
      output.write(`- ${team.name}\t${team.scope}\t${team.path}\n`);
    }
    return;
  }

  if (parsed.listModels) {
    const results = await listProviderModels({
      provider: process.argv.includes("--provider") ? parsed.provider : undefined,
      cwd: parsed.cwd,
    });

    if (parsed.json) {
      output.write(`${JSON.stringify({ providers: results }, null, 2)}\n`);
    } else {
      printProviderModels(results);
    }
    return;
  }

  const stdinPrompt = await readPromptFromStdin();
  const prompt = parsed.prompt ?? stdinPrompt;
  const explicitProvider = process.argv.includes("--provider");
  const runTeamMode = !parsed.chat && shouldRunTeamMode({
    explicitTeam: parsed.team,
    explicitProvider,
    hasProjectTeamContext: await hasProjectTeamContext(parsed.cwd),
  });
  const outputMode = process.argv.includes("--output")
    ? parsed.outputMode
    : (parsed.chat
      ? (input.isTTY && output.isTTY ? "tui" : "raw")
      : (runTeamMode ? (input.isTTY && output.isTTY ? "tui" : "raw") : (input.isTTY && output.isTTY ? "tui" : "raw")));

  async function runSelectedTeam(teamOptions: {
    cwd: string;
    teamName?: string;
    prompt?: string;
    systemPrompt?: string;
    model?: string;
    providerModels?: Partial<Record<AdapterProvider, string>>;
    memberModels?: Record<string, string>;
    runMode: AdapterRunMode;
    permissionMode: AdapterPermissionMode;
    questionMode: AdapterQuestionMode;
  }) {
    if (input.isTTY && output.isTTY) {
      await runTeamTui(teamOptions, (opts, onEvent) =>
        runTeamPrototype({ ...opts, onEvent }),
      );
      return;
    }

    if (!input.isTTY || !output.isTTY) {
      stderr.write("kyros: team TUI disabled because stdin/stdout is not a TTY; falling back to raw output.\n");
    }
    await runTeamPrototype(teamOptions);
  }

  if (runTeamMode) {
    const teamOptions = {
      cwd: parsed.cwd,
      teamName: parsed.teamName,
      prompt,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
      providerModels: parseTeamModelOverrides(parsed.teamModels),
      memberModels: parseTeamMemberModelOverrides(parsed.teamMemberModels),
      runMode: parsed.runMode,
      permissionMode: parsed.permissionMode,
      questionMode: parsed.questionMode,
    };
    await runSelectedTeam(teamOptions);
    return;
  }

  if (outputMode === "tui") {
    if (!input.isTTY || !output.isTTY) {
      throw new Error("TUI mode requires an interactive terminal.");
    }

    const tuiResult = await runTui({
      provider: parsed.provider,
      cwd: parsed.cwd,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      permissionMode: parsed.permissionMode,
      runMode: parsed.runMode,
      questionMode: parsed.questionMode,
      outputMode,
      initialPrompt: prompt,
      refreshModels: parsed.refreshModels,
    });

    if (tuiResult.action?.type === "run-team") {
      await runSelectedTeam({
        cwd: parsed.cwd,
        teamName: tuiResult.action.teamName,
        model: tuiResult.action.model,
        systemPrompt: parsed.systemPrompt,
        prompt: undefined,
        runMode: tuiResult.action.runMode,
        permissionMode: tuiResult.action.permissionMode,
        questionMode: tuiResult.action.questionMode,
      });
    }
    return;
  }

  if (!prompt) {
    throw new Error("A prompt is required. Pass --prompt or pipe prompt text on stdin.");
  }

  const options: CliOptions = {
    ...parsed,
    prompt,
    outputMode,
  };

  registerBuiltinAdapters();
  const adapter = getAdapter(options.provider);
  const rl = createInterface({ input, output });

  const config: AdapterSessionConfig = {
    cwd: options.cwd,
    model: options.model,
    systemPrompt: options.systemPrompt,
    runMode: options.runMode,
    questionMode: options.questionMode,
    permissions: {
      mode: options.permissionMode,
    },
    onQuestion: async (request) => askQuestions(rl, request),
    ...(options.permissionMode === "interactive"
      ? {
          onPermissionRequest: async (request: PermissionRequest) => {
            const decision = await askPermission(rl, request);
            return decision === "allow"
              ? { behavior: "allow", updatedInput: request.input }
              : { behavior: "deny", message: "Denied in Kyros CLI." };
          },
        }
      : {}),
  };

  printHeader(options);

  const session = await adapter.createSession(config);
  const streamState = { textOpen: false };
  const claudePrettyRenderer =
    options.provider === "claudeCode" && options.outputMode === "pretty"
      ? new ClaudePrettyRenderer(output)
      : null;

  try {
    await session.send(options.prompt);
    for await (const event of session.stream()) {
      if (claudePrettyRenderer?.handle(event, streamState)) {
        continue;
      }
      handleStreamEvent(event, streamState, {
        showProviderEvents: options.outputMode === "raw",
      });
    }
  } finally {
    if (streamState.textOpen) {
      output.write("\n");
    }
    rl.close();
    await session.close();
  }
}

function parseTeamModelOverrides(rawValues: string[]): Partial<Record<AdapterProvider, string>> | undefined {
  if (rawValues.length === 0) {
    return undefined;
  }

  const result: Partial<Record<AdapterProvider, string>> = {};
  for (const raw of rawValues) {
    const [provider = "", ...modelParts] = raw.split("=");
    const model = modelParts.join("=").trim();
    if (!isProvider(provider) || !model) {
      throw new Error(`Invalid --team-model "${raw}". Expected claudeCode=<model>, codex=<model>, or opencode=<model>.`);
    }
    result[provider] = model;
  }

  return result;
}

function parseTeamMemberModelOverrides(rawValues: string[]): Record<string, string> | undefined {
  if (rawValues.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const raw of rawValues) {
    const [member = "", ...modelParts] = raw.split("=");
    const model = modelParts.join("=").trim();
    const key = member
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!key || !model) {
      throw new Error(`Invalid --team-member-model "${raw}". Expected member=<model>.`);
    }

    result[key] = model;
  }

  return result;
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
