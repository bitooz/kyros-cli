import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { env as processEnv, stderr as processStderr, stdout as processStdout } from "node:process";

export interface PackageInfo {
  name: string;
  version: string;
  updateManifestUrl?: string;
}

export interface UpdateInstaller {
  url: string;
  sha256?: string;
  args?: string[];
}

export interface UpdateManifest {
  version: string;
  notesUrl?: string;
  installer?: UpdateInstaller;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  manifest: UpdateManifest;
}

export interface UpdateCommandOptions {
  checkOnly?: boolean;
  dryRun?: boolean;
  manifestUrl?: string;
  currentVersion?: string;
}

type Writer = {
  write(chunk: string): unknown;
};

type FetchImpl = typeof fetch;

type InstallerRunner = (
  script: string,
  args: string[],
) => Promise<number>;

interface PackageJson {
  name?: string;
  version?: string;
  repository?: string | {
    url?: string;
  };
  kyros?: {
    updates?: {
      manifestUrl?: string;
    };
  };
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

interface UpdateCheckState {
  lastCheckedAt?: string;
  latestVersion?: string;
}

const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 1_200;
const DEFAULT_UPDATE_COMMAND_TIMEOUT_MS = 20_000;

function readPackageJson(): PackageJson {
  try {
    const require = createRequire(import.meta.url);
    return require("../package.json") as PackageJson;
  } catch {
    return {};
  }
}

function extractGitHubRepo(repository: PackageJson["repository"]): string | undefined {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) {
    return undefined;
  }

  const match = raw.match(/github\.com[:/]([^/\s]+)\/([^/\s.]+)(?:\.git)?/i);
  if (!match) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

function defaultManifestUrl(pkg: PackageJson): string | undefined {
  const repo = extractGitHubRepo(pkg.repository);
  return repo ? `https://github.com/${repo}/releases/latest/download/kyros-cli-update.json` : undefined;
}

export function getPackageInfo(): PackageInfo {
  const pkg = readPackageJson();
  return {
    name: pkg.name || "kyros",
    version: pkg.version || "0.0.0",
    updateManifestUrl: pkg.kyros?.updates?.manifestUrl ?? defaultManifestUrl(pkg),
  };
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 0;
  }
  if (a.length === 0) {
    return 1;
  }
  if (b.length === 0) {
    return -1;
  }

  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) {
      return -1;
    }
    if (right === undefined) {
      return 1;
    }
    if (left === right) {
      continue;
    }

    const leftNumber = /^\d+$/.test(left) ? Number.parseInt(left, 10) : undefined;
    const rightNumber = /^\d+$/.test(right) ? Number.parseInt(right, 10) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return leftNumber - rightNumber;
    }
    if (leftNumber !== undefined) {
      return -1;
    }
    if (rightNumber !== undefined) {
      return 1;
    }
    return left.localeCompare(right);
  }

  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return a.localeCompare(b, undefined, { numeric: true });
  }

  const major = left.major - right.major;
  if (major !== 0) {
    return major;
  }
  const minor = left.minor - right.minor;
  if (minor !== 0) {
    return minor;
  }
  const patch = left.patch - right.patch;
  if (patch !== 0) {
    return patch;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function requireManifestUrl(manifestUrl: string | undefined): string {
  const value = manifestUrl?.trim();
  if (!value) {
    throw new Error("No update manifest URL is configured.");
  }

  const protocol = new URL(value).protocol;
  if (protocol !== "https:" && protocol !== "http:" && protocol !== "data:") {
    throw new Error(`Invalid update manifest URL "${value}". Expected http, https, or data.`);
  }
  return value;
}

function requireInstallerUrl(installerUrl: string): string {
  const protocol = new URL(installerUrl).protocol;
  if (protocol !== "https:" && protocol !== "data:") {
    throw new Error(`Invalid update installer URL "${installerUrl}". Expected https or data.`);
  }
  return installerUrl;
}

function normalizeManifest(raw: unknown): UpdateManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Update manifest must be a JSON object.");
  }

  const value = raw as {
    version?: unknown;
    latestVersion?: unknown;
    notesUrl?: unknown;
    url?: unknown;
    installer?: unknown;
  };
  const version = typeof value.version === "string"
    ? value.version
    : (typeof value.latestVersion === "string" ? value.latestVersion : undefined);
  if (!version?.trim()) {
    throw new Error("Update manifest is missing a version.");
  }

  let installer: UpdateInstaller | undefined;
  if (value.installer !== undefined) {
    if (!value.installer || typeof value.installer !== "object") {
      throw new Error("Update manifest installer must be an object.");
    }
    const rawInstaller = value.installer as {
      url?: unknown;
      sha256?: unknown;
      args?: unknown;
    };
    if (typeof rawInstaller.url !== "string" || !rawInstaller.url.trim()) {
      throw new Error("Update manifest installer is missing a URL.");
    }
    installer = {
      url: requireInstallerUrl(rawInstaller.url),
      ...(typeof rawInstaller.sha256 === "string" && rawInstaller.sha256.trim()
        ? { sha256: rawInstaller.sha256 }
        : {}),
      ...(Array.isArray(rawInstaller.args) && rawInstaller.args.every((item) => typeof item === "string")
        ? { args: rawInstaller.args }
        : {}),
    };
  }

  return {
    version,
    ...(typeof value.notesUrl === "string" && value.notesUrl.trim() ? { notesUrl: value.notesUrl } : {}),
    ...(typeof value.url === "string" && value.url.trim() && typeof value.notesUrl !== "string" ? { notesUrl: value.url } : {}),
    ...(installer ? { installer } : {}),
  };
}

async function fetchJson(options: {
  url: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}): Promise<unknown> {
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("This Node.js runtime does not provide fetch; use Node 18 or newer.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_UPDATE_COMMAND_TIMEOUT_MS);
  try {
    const response = await fetcher(options.url, {
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Update server returned HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForUpdate(options: {
  currentVersion?: string;
  manifestUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
} = {}): Promise<UpdateCheckResult> {
  const packageInfo = getPackageInfo();
  const currentVersion = options.currentVersion ?? packageInfo.version;
  const manifestUrl = requireManifestUrl(options.manifestUrl ?? processEnv.KYROS_UPDATE_MANIFEST_URL ?? packageInfo.updateManifestUrl);
  const manifest = normalizeManifest(await fetchJson({
    url: manifestUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  }));

  return {
    currentVersion,
    latestVersion: manifest.version,
    updateAvailable: compareVersions(manifest.version, currentVersion) > 0,
    manifest,
  };
}

function configDir(env: NodeJS.ProcessEnv): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome ? join(xdgConfigHome, "kyros") : join(homedir(), ".config", "kyros");
}

function updateStatePath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), "update-check.json");
}

function readUpdateState(env: NodeJS.ProcessEnv): UpdateCheckState {
  const path = updateStatePath(env);
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateCheckState;
  } catch {
    return {};
  }
}

function writeUpdateState(env: NodeJS.ProcessEnv, state: UpdateCheckState): void {
  const path = updateStatePath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Update checks must never make normal CLI execution fail.
  }
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function configuredIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.KYROS_UPDATE_CHECK_INTERVAL_MS;
  if (!raw) {
    return DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_UPDATE_CHECK_INTERVAL_MS;
}

export function shouldRunStartupUpdateCheck(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
}): boolean {
  const env = options.env ?? processEnv;
  if (!options.stdinIsTTY || !options.stderrIsTTY) {
    return false;
  }
  if (env.CI || truthyEnv(env.KYROS_NO_UPDATE_CHECK) || truthyEnv(env.KYROS_DISABLE_UPDATE_CHECK)) {
    return false;
  }
  if (options.argv.includes("--help") || options.argv.includes("-h") || options.argv.includes("--version") || options.argv.includes("-v")) {
    return false;
  }

  const command = options.argv.find((arg) => arg && arg !== "--");
  return command !== "help" &&
    command !== "version" &&
    command !== "update" &&
    command !== "upgrade" &&
    command !== "mcp" &&
    command !== "models" &&
    command !== "teams";
}

export async function maybeNotifyUpdate(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  writer?: Writer;
  now?: Date;
  force?: boolean;
  currentVersion?: string;
  manifestUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
} = {}): Promise<{ checked: boolean; result?: UpdateCheckResult }> {
  const env = options.env ?? processEnv;
  const now = options.now ?? new Date();
  const intervalMs = options.intervalMs ?? configuredIntervalMs(env);
  const state = readUpdateState(env);
  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
  if (!options.force && Number.isFinite(lastCheckedAt) && now.getTime() - lastCheckedAt < intervalMs) {
    return { checked: false };
  }

  try {
    const result = await checkForUpdate({
      currentVersion: options.currentVersion,
      manifestUrl: options.manifestUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
    });
    writeUpdateState(env, {
      lastCheckedAt: now.toISOString(),
      latestVersion: result.latestVersion,
    });

    if (result.updateAvailable) {
      const notes = result.manifest.notesUrl ? ` ${result.manifest.notesUrl}` : "";
      const writer = options.writer ?? processStderr;
      writer.write(`kyros ${result.latestVersion} is available (current ${result.currentVersion}). Run "kyros update" to install.${notes}\n`);
    }

    return { checked: true, result };
  } catch {
    writeUpdateState(env, {
      lastCheckedAt: now.toISOString(),
      latestVersion: state.latestVersion,
    });
    return { checked: false };
  }
}

async function downloadText(options: {
  url: string;
  fetchImpl?: FetchImpl;
}): Promise<string> {
  const fetcher = options.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("This Node.js runtime does not provide fetch; use Node 18 or newer.");
  }

  const response = await fetcher(options.url, {
    headers: {
      accept: "application/x-sh,text/plain,*/*",
    },
  });
  if (!response.ok) {
    throw new Error(`Installer download returned HTTP ${response.status}`);
  }
  return response.text();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function defaultRunInstaller(script: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-s", "--", ...args], {
      shell: osPlatform() === "win32",
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
    child.stdin.end(script);
  });
}

export async function runUpdateCommand(
  options: UpdateCommandOptions,
  deps: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchImpl;
    runInstaller?: InstallerRunner;
    stdout?: Writer;
  } = {},
): Promise<UpdateCheckResult> {
  const stdout = deps.stdout ?? processStdout;
  const check = await checkForUpdate({
    currentVersion: options.currentVersion,
    manifestUrl: options.manifestUrl,
    fetchImpl: deps.fetchImpl,
  });

  if (!check.updateAvailable) {
    stdout.write(`kyros is up to date (${check.currentVersion}).\n`);
    return check;
  }

  stdout.write(`Update available: ${check.currentVersion} -> ${check.latestVersion}\n`);
  if (check.manifest.notesUrl) {
    stdout.write(`Release notes: ${check.manifest.notesUrl}\n`);
  }
  if (options.checkOnly) {
    return check;
  }

  const installer = check.manifest.installer;
  if (!installer) {
    throw new Error("This release does not provide an automatic CLI installer. Install it manually from the project releases.");
  }

  const args = installer.args ?? [];
  if (options.dryRun) {
    stdout.write(`Would run installer: ${installer.url}${args.length ? ` ${args.join(" ")}` : ""}\n`);
    return check;
  }

  const script = await downloadText({
    url: installer.url,
    fetchImpl: deps.fetchImpl,
  });
  if (installer.sha256) {
    const actual = sha256(script);
    if (actual !== installer.sha256.toLowerCase()) {
      throw new Error(`Installer checksum mismatch. Expected ${installer.sha256}, got ${actual}.`);
    }
  }

  stdout.write(`Running installer for kyros ${check.latestVersion}...\n`);
  const exitCode = await (deps.runInstaller ?? defaultRunInstaller)(script, args);
  if (exitCode !== 0) {
    throw new Error(`Update installer failed with exit code ${exitCode}.`);
  }

  stdout.write(`Updated kyros to ${check.latestVersion}. Restart kyros to use the new version.\n`);
  return check;
}
