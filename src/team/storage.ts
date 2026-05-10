import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";

const TEAM_FILE_EXTENSIONS = [".json", ".md"] as const;
const PRIMARY_TEAM_FILE_EXTENSION = TEAM_FILE_EXTENSIONS[0];
const PROJECT_DIRECTORY = ".kyros";
const PROJECT_TEAM_CONFIG_FILES = ["roles.json", "roles.md"] as const;
const PROJECT_TEAM_CONTEXT_FILES = ["goal.md", "plan.md", "spec.md", "tasks.md"] as const;
type ProjectContextFileName = typeof PROJECT_TEAM_CONTEXT_FILES[number];
type ProjectFileName = ProjectContextFileName | typeof PROJECT_TEAM_CONFIG_FILES[number];
type SavedTeamScope = "local" | "global";

function ensureTrailingNewline(text: string): string {
  return text.trimEnd() ? `${text.trimEnd()}\n` : "";
}

export function slugifyTeamName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/\.(?:json|md)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error("Team name cannot be empty.");
  }

  return normalized;
}

export function resolveTeamsDirectory(cwd: string): string {
  return resolveProjectDirectory(cwd, "teams");
}

export function resolveGlobalTeamsDirectory(): string {
  return resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "kyros", "teams");
}

export function resolveTeamDefinitionPath(cwd: string, name: string): string {
  return resolve(resolveTeamsDirectory(cwd), `${slugifyTeamName(name)}${PRIMARY_TEAM_FILE_EXTENSION}`);
}

export function resolveGlobalTeamDefinitionPath(name: string): string {
  return resolve(resolveGlobalTeamsDirectory(), `${slugifyTeamName(name)}${PRIMARY_TEAM_FILE_EXTENSION}`);
}

export function resolveProjectDirectory(cwd: string, ...segments: string[]): string {
  return resolve(cwd, PROJECT_DIRECTORY, ...segments);
}

export function resolveProjectContextPath(cwd: string, fileName: ProjectFileName): string {
  return resolveProjectDirectory(cwd, fileName);
}

export function resolveDefaultProjectTeamConfigPath(cwd: string): string {
  return resolveProjectDirectory(cwd, PROJECT_TEAM_CONFIG_FILES[0]);
}

export interface SavedTeamDefinition {
  name: string;
  slug: string;
  path: string;
  scope: SavedTeamScope;
  content: string;
}

export interface SavedTeamSummary {
  name: string;
  slug: string;
  path: string;
  scope: SavedTeamScope;
  updatedAtMs: number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function resolveProjectTeamConfigPath(cwd: string): Promise<string> {
  const projectCwd = resolve(cwd);

  for (const fileName of PROJECT_TEAM_CONFIG_FILES) {
    const path = resolveProjectDirectory(projectCwd, fileName);
    if (await pathExists(path)) {
      return path;
    }
  }

  for (const fileName of PROJECT_TEAM_CONFIG_FILES) {
    const path = resolve(projectCwd, fileName);
    if (await pathExists(path)) {
      return path;
    }
  }

  return resolveDefaultProjectTeamConfigPath(projectCwd);
}

export async function hasProjectTeamContext(cwd: string): Promise<boolean> {
  const projectCwd = resolve(cwd);

  for (const fileName of PROJECT_TEAM_CONTEXT_FILES) {
    if (!(await pathExists(resolveProjectDirectory(projectCwd, fileName)))
      && !(await pathExists(resolve(projectCwd, fileName)))) {
      return false;
    }
  }

  const teamConfigPath = await resolveProjectTeamConfigPath(projectCwd);
  return pathExists(teamConfigPath);
}

export async function resolveExistingProjectContextPath(
  cwd: string,
  fileName: ProjectContextFileName,
): Promise<string> {
  const projectCwd = resolve(cwd);
  const primaryPath = resolveProjectContextPath(projectCwd, fileName);
  if (await pathExists(primaryPath)) {
    return primaryPath;
  }

  const legacyPath = resolve(projectCwd, fileName);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return primaryPath;
}

async function listTeamDefinitionsInDirectory(
  directory: string,
  scope: SavedTeamScope,
): Promise<SavedTeamSummary[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const teams = new Map<string, SavedTeamSummary>();

    for (const entry of entries) {
      if (!entry.isFile() || !TEAM_FILE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        continue;
      }

      const path = resolve(directory, entry.name);
      const details = await stat(path);
      const slug = basename(entry.name, entry.name.endsWith(".json") ? ".json" : ".md");
      const nextSummary = {
        name: slug,
        slug,
        path,
        scope,
        updatedAtMs: details.mtimeMs,
      } satisfies SavedTeamSummary;
      const previous = teams.get(slug);

      if (!previous) {
        teams.set(slug, nextSummary);
        continue;
      }

      const previousIsPrimary = previous.path.endsWith(PRIMARY_TEAM_FILE_EXTENSION);
      const nextIsPrimary = path.endsWith(PRIMARY_TEAM_FILE_EXTENSION);
      if (
        (!previousIsPrimary && nextIsPrimary) ||
        (previousIsPrimary === nextIsPrimary && nextSummary.updatedAtMs > previous.updatedAtMs)
      ) {
        teams.set(slug, nextSummary);
      }
    }

    return [...teams.values()].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function listTeamDefinitions(cwd: string): Promise<SavedTeamSummary[]> {
  const teams = new Map<string, SavedTeamSummary>();

  for (const team of await listTeamDefinitionsInDirectory(resolveGlobalTeamsDirectory(), "global")) {
    teams.set(team.slug, team);
  }

  for (const team of await listTeamDefinitionsInDirectory(resolveTeamsDirectory(cwd), "local")) {
    teams.set(team.slug, team);
  }

  return [...teams.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

export async function loadTeamDefinition(cwd: string, name: string): Promise<SavedTeamDefinition> {
  const slug = slugifyTeamName(name);

  for (const [directory, scope] of [
    [resolveTeamsDirectory(cwd), "local"],
    [resolveGlobalTeamsDirectory(), "global"],
  ] as const) {
    for (const extension of TEAM_FILE_EXTENSIONS) {
      const path = resolve(directory, `${slug}${extension}`);

      try {
        const content = await readFile(path, "utf8");
        return {
          name: slug,
          slug,
          path,
          scope,
          content,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }
  }

  throw new Error(`Saved team "${name}" was not found in ${resolveTeamsDirectory(cwd)} or ${resolveGlobalTeamsDirectory()}.`);
}

export async function saveTeamDefinition(
  cwd: string,
  name: string,
  content: string,
  scope: SavedTeamScope = "global",
): Promise<SavedTeamDefinition> {
  const slug = slugifyTeamName(name);
  const path = scope === "local"
    ? resolveTeamDefinitionPath(cwd, slug)
    : resolveGlobalTeamDefinitionPath(slug);
  await mkdir(scope === "local" ? resolveTeamsDirectory(cwd) : resolveGlobalTeamsDirectory(), { recursive: true });
  await writeFile(path, ensureTrailingNewline(content), "utf8");

  return {
    name: slug,
    slug,
    path,
    scope,
    content: ensureTrailingNewline(content),
  };
}
