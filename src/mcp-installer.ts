import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterProvider } from "./adapters/types.js";

export type McpInstallProvider = AdapterProvider;

export interface McpOAuthConfig {
  clientId?: string;
  clientSecretEnvVar?: string;
  scopes?: string;
  callbackPort?: number;
  authServerMetadataUrl?: string;
}

export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeout?: number;
    }
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      envHttpHeaders?: Record<string, string>;
      bearerTokenEnvVar?: string;
      oauth?: false | McpOAuthConfig;
      oauthResource?: string;
      timeout?: number;
    };

export interface InstallMcpServerOptions {
  name: string;
  server: McpServerConfig;
  providers?: McpInstallProvider[];
  homeDir?: string;
  codexHome?: string;
  xdgConfigHome?: string;
  dryRun?: boolean;
}

export interface McpInstallResult {
  provider: McpInstallProvider;
  path: string;
  action: "installed" | "planned";
}

export interface McpServerEntry {
  name: string;
  server: McpServerConfig;
}

export const MCP_INSTALL_PROVIDERS: McpInstallProvider[] = ["claudeCode", "codex", "opencode"];

const OPENCODE_SCHEMA = "https://opencode.ai/config.json";
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const entries = Object.entries(record);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== "string") {
      return undefined;
    }
    result[key] = entryValue;
  }
  return result;
}

function asHeaders(input: unknown): {
  headers?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
} {
  const record = asRecord(input);
  if (!record) {
    return {};
  }

  const headers: Record<string, string> = {};
  const envHttpHeaders: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;

  for (const [header, value] of Object.entries(record)) {
    if (typeof value !== "string") {
      continue;
    }

    const envOnlyMatch = value.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (envOnlyMatch?.[1]) {
      envHttpHeaders[header] = validateEnvVarName(envOnlyMatch[1]);
      continue;
    }

    const bearerEnvMatch = header.toLowerCase() === "authorization"
      ? value.match(/^Bearer\s+\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/i)
      : undefined;
    if (bearerEnvMatch?.[1]) {
      bearerTokenEnvVar = validateEnvVarName(bearerEnvMatch[1]);
      continue;
    }

    headers[header] = value;
  }

  return {
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(envHttpHeaders).length ? { envHttpHeaders } : {}),
    ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
  };
}

function validateEnvVarName(name: string): string {
  if (!ENV_VAR_PATTERN.test(name)) {
    throw new Error(`Invalid environment variable name "${name}".`);
  }
  return name;
}

function normalizeOAuthConfig(value: unknown): false | McpOAuthConfig | undefined {
  if (value == null) {
    return undefined;
  }
  if (value === false) {
    return false;
  }

  const record = asRecord(value);
  if (!record) {
    throw new Error("MCP OAuth configuration must be an object or false.");
  }

  const clientId = typeof record.clientId === "string" ? record.clientId : undefined;
  const clientSecretEnvVar = typeof record.clientSecretEnvVar === "string"
    ? validateEnvVarName(record.clientSecretEnvVar)
    : undefined;
  const scopeValue = typeof record.scopes === "string"
    ? record.scopes
    : (typeof record.scope === "string" ? record.scope : undefined);
  const callbackPort = typeof record.callbackPort === "number" && Number.isInteger(record.callbackPort) && record.callbackPort > 0
    ? record.callbackPort
    : undefined;
  const authServerMetadataUrl = typeof record.authServerMetadataUrl === "string"
    ? record.authServerMetadataUrl
    : undefined;

  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecretEnvVar ? { clientSecretEnvVar } : {}),
    ...(scopeValue ? { scopes: scopeValue } : {}),
    ...(callbackPort ? { callbackPort } : {}),
    ...(authServerMetadataUrl ? { authServerMetadataUrl } : {}),
  };
}

function asTimeout(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function pathExists(path: string): Promise<boolean> {
  return access(path, fsConstants.F_OK)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  if (!await pathExists(path)) {
    return undefined;
  }
  return readFile(path, "utf8");
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

function uniqueProviders(providers: McpInstallProvider[]): McpInstallProvider[] {
  return MCP_INSTALL_PROVIDERS.filter((provider) => providers.includes(provider));
}

export function validateMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid MCP server name "${name}". Use letters, numbers, underscores, and hyphens only.`);
  }
}

export function normalizeMcpServerConfig(input: unknown): McpServerConfig {
  const record = asRecord(input);
  if (!record) {
    throw new Error("MCP server configuration must be a JSON object.");
  }

  const rawType = typeof record.type === "string" ? record.type : undefined;
  const timeout = asTimeout(record.timeout);
  const env = asStringMap(record.env ?? record.environment);
  const headerConfig = asHeaders(record.headers);
  const envHttpHeaders = asStringMap(record.envHttpHeaders ?? record.env_http_headers);
  const bearerTokenEnvVar = typeof record.bearerTokenEnvVar === "string"
    ? validateEnvVarName(record.bearerTokenEnvVar)
    : (
      typeof record.bearer_token_env_var === "string"
        ? validateEnvVarName(record.bearer_token_env_var)
        : undefined
    );
  const oauth = normalizeOAuthConfig(record.oauth);
  const oauthResource = typeof record.oauthResource === "string"
    ? record.oauthResource
    : (typeof record.oauth_resource === "string" ? record.oauth_resource : undefined);

  if (rawType === "local" || rawType === "stdio" || (!rawType && hasOwn(record, "command"))) {
    if (Array.isArray(record.command)) {
      const commandParts = asStringArray(record.command);
      if (!commandParts || commandParts.length === 0) {
        throw new Error("Local MCP server command arrays must contain at least one string.");
      }
      const [command, ...args] = commandParts;
      return {
        type: "stdio",
        command: command!,
        ...(args.length ? { args } : {}),
        ...(env ? { env } : {}),
        ...(timeout ? { timeout } : {}),
      };
    }

    if (typeof record.command !== "string" || record.command.trim() === "") {
      throw new Error("Local MCP server configuration must include a non-empty command.");
    }

    const args = asStringArray(record.args);
    if (record.args != null && !args) {
      throw new Error("Local MCP server args must be an array of strings.");
    }

    return {
      type: "stdio",
      command: record.command,
      ...(args?.length ? { args } : {}),
      ...(env ? { env } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }

  if (
    rawType === "remote" ||
    rawType === "http" ||
    rawType === "sse" ||
    rawType === "streamable-http" ||
    rawType === "streamable_http" ||
    hasOwn(record, "url") ||
    hasOwn(record, "serverUrl") ||
    hasOwn(record, "server_url")
  ) {
    const rawUrl = typeof record.url === "string"
      ? record.url
      : (typeof record.serverUrl === "string"
        ? record.serverUrl
        : (typeof record.server_url === "string" ? record.server_url : undefined));
    if (!rawUrl?.trim()) {
      throw new Error("Remote MCP server configuration must include a non-empty url.");
    }

    return {
      type: "http",
      url: rawUrl,
      ...(headerConfig.headers ? { headers: headerConfig.headers } : {}),
      ...(envHttpHeaders || headerConfig.envHttpHeaders
        ? { envHttpHeaders: { ...(envHttpHeaders ?? {}), ...(headerConfig.envHttpHeaders ?? {}) } }
        : {}),
      ...(bearerTokenEnvVar || headerConfig.bearerTokenEnvVar
        ? { bearerTokenEnvVar: bearerTokenEnvVar ?? headerConfig.bearerTokenEnvVar }
        : {}),
      ...(oauth !== undefined ? { oauth } : {}),
      ...(oauthResource ? { oauthResource } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }

  throw new Error("Unsupported MCP server configuration. Expected a stdio/local command or http/remote url.");
}

function looksLikeMcpServerConfig(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && (
    hasOwn(record, "command") ||
    hasOwn(record, "url") ||
    hasOwn(record, "serverUrl") ||
    hasOwn(record, "server_url") ||
    record.type === "local" ||
    record.type === "stdio" ||
    record.type === "remote" ||
    record.type === "http" ||
    record.type === "sse" ||
    record.type === "streamable-http" ||
    record.type === "streamable_http"
  ));
}

function normalizeMcpServerMap(map: Record<string, unknown>): McpServerEntry[] {
  return Object.entries(map).flatMap(([name, value]) => {
    if (!looksLikeMcpServerConfig(value)) {
      return [];
    }
    return [{
      name,
      server: normalizeMcpServerConfig(value),
    }];
  });
}

export function normalizeMcpServerEntries(input: unknown, options: { name?: string } = {}): McpServerEntry[] {
  const record = asRecord(input);
  if (!record) {
    throw new Error("MCP JSON must be an object.");
  }

  const wrappedMap = asRecord(record.mcpServers) ?? asRecord(record.mcp) ?? asRecord(record.servers);
  if (wrappedMap) {
    const entries = normalizeMcpServerMap(wrappedMap);
    if (options.name) {
      const selected = entries.find((entry) => entry.name === options.name);
      if (!selected) {
        throw new Error(`MCP JSON does not contain a server named "${options.name}".`);
      }
      return [selected];
    }
    if (entries.length === 0) {
      throw new Error("MCP JSON does not contain any supported servers.");
    }
    return entries;
  }

  if (looksLikeMcpServerConfig(record)) {
    if (!options.name) {
      throw new Error("A server name is required when installing a single MCP server object.");
    }
    return [{
      name: options.name,
      server: normalizeMcpServerConfig(record),
    }];
  }

  const entries = normalizeMcpServerMap(record);
  if (entries.length > 0) {
    if (options.name) {
      const selected = entries.find((entry) => entry.name === options.name);
      if (!selected) {
        throw new Error(`MCP JSON does not contain a server named "${options.name}".`);
      }
      return [selected];
    }
    return entries;
  }

  throw new Error("Unsupported MCP JSON. Expected a server object, mcpServers, or mcp map.");
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        output += input[index] === "\n" ? "\n" : "";
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function parseJsonObject(raw: string, path: string, options: { jsonc?: boolean } = {}): Record<string, unknown> {
  const text = options.jsonc
    ? stripJsonComments(raw).replace(/,\s*([}\]])/g, "$1")
    : raw;
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`Expected ${path} to contain a JSON object.`);
  }
  return record;
}

export function parseMcpJson(raw: string): Record<string, unknown> {
  return parseJsonObject(raw, "MCP JSON", { jsonc: true });
}

async function readJsonObject(path: string, options: { jsonc?: boolean } = {}): Promise<Record<string, unknown>> {
  const raw = await readTextIfExists(path);
  if (!raw?.trim()) {
    return {};
  }
  return parseJsonObject(raw, path, options);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toHeadersHelper(input: {
  bearerTokenEnvVar?: string;
  envHttpHeaders?: Record<string, string>;
}): string | undefined {
  const headers: Array<{ name: string; env: string; prefix?: string }> = [];
  if (input.bearerTokenEnvVar) {
    headers.push({
      name: "Authorization",
      env: input.bearerTokenEnvVar,
      prefix: "Bearer ",
    });
  }

  for (const [name, env] of Object.entries(input.envHttpHeaders ?? {})) {
    headers.push({ name, env: validateEnvVarName(env) });
  }

  if (headers.length === 0) {
    return undefined;
  }

  const script = [
    `const specs = ${JSON.stringify(headers)};`,
    "const headers = {};",
    "for (const spec of specs) {",
    "  const value = process.env[spec.env];",
    "  if (!value) { console.error(`Missing ${spec.env}`); process.exit(1); }",
    "  headers[spec.name] = `${spec.prefix ?? \"\"}${value}`;",
    "}",
    "console.log(JSON.stringify(headers));",
  ].join(" ");

  return `node -e ${shellQuote(script)}`;
}

function toClaudeOAuthConfig(server: Extract<McpServerConfig, { type: "http" }>): Record<string, unknown> | undefined {
  if (!server.oauth) {
    return undefined;
  }

  return {
    ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
    ...(server.oauth.callbackPort ? { callbackPort: server.oauth.callbackPort } : {}),
    ...(server.oauth.authServerMetadataUrl ? { authServerMetadataUrl: server.oauth.authServerMetadataUrl } : {}),
    ...(server.oauth.scopes ? { scopes: server.oauth.scopes } : {}),
  };
}

function toOpenCodeOAuthConfig(server: Extract<McpServerConfig, { type: "http" }>): false | Record<string, unknown> | undefined {
  if (server.oauth === false) {
    return false;
  }

  const usesCustomHeaderAuth = Boolean(server.bearerTokenEnvVar) || Boolean(server.envHttpHeaders && Object.keys(server.envHttpHeaders).length);
  if (!server.oauth) {
    return usesCustomHeaderAuth ? false : undefined;
  }

  const config = {
    ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
    ...(server.oauth.clientSecretEnvVar ? { clientSecret: `{env:${server.oauth.clientSecretEnvVar}}` } : {}),
    ...(server.oauth.scopes ? { scope: server.oauth.scopes } : {}),
  };

  return Object.keys(config).length > 0
    ? config
    : (usesCustomHeaderAuth ? false : undefined);
}

function codexScopes(server: Extract<McpServerConfig, { type: "http" }>): string[] {
  if (!server.oauth || !server.oauth.scopes) {
    return [];
  }
  return server.oauth.scopes
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function toClaudeServerConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    };
  }

  return {
    type: "http",
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
    ...(toHeadersHelper({
      bearerTokenEnvVar: server.bearerTokenEnvVar,
      envHttpHeaders: server.envHttpHeaders,
    })
      ? {
          headersHelper: toHeadersHelper({
            bearerTokenEnvVar: server.bearerTokenEnvVar,
            envHttpHeaders: server.envHttpHeaders,
          }),
        }
      : {}),
    ...(toClaudeOAuthConfig(server) ? { oauth: toClaudeOAuthConfig(server) } : {}),
  };
}

function toOpenCodeServerConfig(server: McpServerConfig): Record<string, unknown> {
  if (server.type === "stdio") {
    return {
      type: "local",
      command: [server.command, ...(server.args ?? [])],
      enabled: true,
      ...(server.env && Object.keys(server.env).length ? { environment: server.env } : {}),
      ...(server.timeout ? { timeout: server.timeout } : {}),
    };
  }

  return {
    type: "remote",
    url: server.url,
    enabled: true,
    ...((server.headers && Object.keys(server.headers).length) || server.bearerTokenEnvVar || server.envHttpHeaders
      ? {
          headers: {
            ...(server.headers ?? {}),
            ...(server.bearerTokenEnvVar
              ? { Authorization: `Bearer {env:${server.bearerTokenEnvVar}}` }
              : {}),
            ...Object.fromEntries(
              Object.entries(server.envHttpHeaders ?? {}).map(([header, env]) => [header, `{env:${validateEnvVarName(env)}}`]),
            ),
          },
        }
      : {}),
    ...(toOpenCodeOAuthConfig(server) !== undefined ? { oauth: toOpenCodeOAuthConfig(server) } : {}),
    ...(server.timeout ? { timeout: server.timeout } : {}),
  };
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key)
    ? key
    : JSON.stringify(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineStringMap(value: Record<string, string>): string {
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${tomlKey(key)} = ${tomlString(entryValue)}`);
  return `{ ${entries.join(", ")} }`;
}

function toCodexTomlBlock(name: string, server: McpServerConfig): string {
  const lines = [`[mcp_servers.${tomlKey(name)}]`, "enabled = true"];

  if (server.type === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args?.length) {
      lines.push(`args = ${tomlArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${tomlInlineStringMap(server.env)}`);
    }
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (server.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
    }
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`http_headers = ${tomlInlineStringMap(server.headers)}`);
    }
    if (server.envHttpHeaders && Object.keys(server.envHttpHeaders).length > 0) {
      lines.push(`env_http_headers = ${tomlInlineStringMap(server.envHttpHeaders)}`);
    }
    if (server.oauthResource) {
      lines.push(`oauth_resource = ${tomlString(server.oauthResource)}`);
    }
    const scopes = codexScopes(server);
    if (scopes.length > 0) {
      lines.push(`scopes = ${tomlArray(scopes)}`);
    }
  }

  if (server.timeout) {
    lines.push(`startup_timeout_ms = ${server.timeout}`);
  }

  return `${lines.join("\n")}\n`;
}

function toCodexGlobalToml(server: McpServerConfig): string {
  if (server.type !== "http" || !server.oauth || !server.oauth.callbackPort) {
    return "";
  }
  return `mcp_oauth_callback_port = ${server.oauth.callbackPort}\n`;
}

function removeCodexRootKeys(content: string, keys: string[]): string {
  const keyPattern = new RegExp(`^\\s*(?:${keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*=`);
  return content
    .split(/\r?\n/)
    .filter((line) => !keyPattern.test(line))
    .join("\n")
    .trimStart();
}

function parseTomlPath(raw: string): string[] {
  const parts: string[] = [];
  let index = 0;

  while (index < raw.length) {
    while (raw[index] === " " || raw[index] === ".") {
      index += 1;
    }

    if (index >= raw.length) {
      break;
    }

    if (raw[index] === "\"") {
      index += 1;
      let value = "";
      let escaped = false;
      while (index < raw.length) {
        const char = raw[index]!;
        index += 1;
        if (escaped) {
          value += char;
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          break;
        }
        value += char;
      }
      parts.push(value);
      continue;
    }

    let value = "";
    while (index < raw.length && raw[index] !== "." && raw[index] !== " ") {
      value += raw[index];
      index += 1;
    }
    if (value) {
      parts.push(value);
    }
  }

  return parts;
}

function parseTomlHeader(line: string): string[] | undefined {
  const match = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
  return match?.[1] ? parseTomlPath(match[1]) : undefined;
}

function removeCodexMcpServerBlocks(content: string, name: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const path = parseTomlHeader(line);
    if (path) {
      skipping = path[0] === "mcp_servers" && path[1] === name;
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trimEnd();
}

async function installClaudeMcpServer(options: {
  name: string;
  server: McpServerConfig;
  path: string;
  dryRun?: boolean;
}): Promise<McpInstallResult> {
  if (!options.dryRun) {
    const config = await readJsonObject(options.path);
    const mcpServers = asRecord(config.mcpServers) ?? {};
    config.mcpServers = {
      ...mcpServers,
      [options.name]: toClaudeServerConfig(options.server),
    };
    await writeTextAtomic(options.path, `${JSON.stringify(config, null, 2)}\n`);
  }

  return {
    provider: "claudeCode",
    path: options.path,
    action: options.dryRun ? "planned" : "installed",
  };
}

async function installCodexMcpServer(options: {
  name: string;
  server: McpServerConfig;
  path: string;
  dryRun?: boolean;
}): Promise<McpInstallResult> {
  if (!options.dryRun) {
    const existing = await readTextIfExists(options.path) ?? "";
    const withoutExistingGlobals = removeCodexRootKeys(existing, ["mcp_oauth_callback_port"]);
    const withoutExistingServer = removeCodexMcpServerBlocks(withoutExistingGlobals, options.name);
    const nextContent = [
      toCodexGlobalToml(options.server).trimEnd(),
      withoutExistingServer,
      toCodexTomlBlock(options.name, options.server).trimEnd(),
    ].filter((part) => part.trim()).join("\n\n");
    await writeTextAtomic(options.path, `${nextContent}\n`);
  }

  return {
    provider: "codex",
    path: options.path,
    action: options.dryRun ? "planned" : "installed",
  };
}

async function installOpenCodeMcpServer(options: {
  name: string;
  server: McpServerConfig;
  path: string;
  dryRun?: boolean;
}): Promise<McpInstallResult> {
  if (!options.dryRun) {
    const config = await readJsonObject(options.path, { jsonc: true });
    if (typeof config.$schema !== "string") {
      config.$schema = OPENCODE_SCHEMA;
    }
    const mcp = asRecord(config.mcp) ?? {};
    config.mcp = {
      ...mcp,
      [options.name]: toOpenCodeServerConfig(options.server),
    };
    await writeTextAtomic(options.path, `${JSON.stringify(config, null, 2)}\n`);
  }

  return {
    provider: "opencode",
    path: options.path,
    action: options.dryRun ? "planned" : "installed",
  };
}

export async function installMcpServer(options: InstallMcpServerOptions): Promise<McpInstallResult[]> {
  validateMcpServerName(options.name);
  const providers = uniqueProviders(options.providers?.length ? options.providers : MCP_INSTALL_PROVIDERS);
  if (providers.length === 0) {
    throw new Error("At least one MCP provider target is required.");
  }

  const home = options.homeDir ?? homedir();
  const codexHome = options.codexHome
    ?? (options.homeDir ? join(home, ".codex") : (process.env.CODEX_HOME ?? join(home, ".codex")));
  const xdgConfigHome = options.xdgConfigHome
    ?? (options.homeDir ? join(home, ".config") : (process.env.XDG_CONFIG_HOME ?? join(home, ".config")));

  const results: McpInstallResult[] = [];
  for (const provider of providers) {
    switch (provider) {
      case "claudeCode":
        results.push(await installClaudeMcpServer({
          name: options.name,
          server: options.server,
          path: join(home, ".claude.json"),
          dryRun: options.dryRun,
        }));
        break;
      case "codex":
        results.push(await installCodexMcpServer({
          name: options.name,
          server: options.server,
          path: join(codexHome, "config.toml"),
          dryRun: options.dryRun,
        }));
        break;
      case "opencode":
        results.push(await installOpenCodeMcpServer({
          name: options.name,
          server: options.server,
          path: join(xdgConfigHome, "opencode", "opencode.json"),
          dryRun: options.dryRun,
        }));
        break;
    }
  }

  return results;
}
