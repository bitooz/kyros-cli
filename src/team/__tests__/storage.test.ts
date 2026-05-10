import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  hasProjectTeamContext,
  listTeamDefinitions,
  loadTeamDefinition,
  resolveGlobalTeamsDirectory,
  saveTeamDefinition,
  slugifyTeamName,
} from "../storage.js";

async function withTempConfigHome<T>(fn: (configHome: string) => Promise<T>): Promise<T> {
  const original = process.env.XDG_CONFIG_HOME;
  const configHome = resolve(tmpdir(), `kyros-config-${randomUUID()}`);

  process.env.XDG_CONFIG_HOME = configHome;

  try {
    return await fn(configHome);
  } finally {
    if (original === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = original;
    }
    await rm(configHome, { recursive: true, force: true }).catch(() => {});
  }
}

describe("team storage", () => {
  it("slugifies team names consistently", () => {
    expect(slugifyTeamName(" Product Squad ")).toBe("product-squad");
    expect(slugifyTeamName("design-system.md")).toBe("design-system");
    expect(slugifyTeamName("design-system.json")).toBe("design-system");
  });

  it("saves, lists, and loads global team definitions", async () => {
    await withTempConfigHome(async () => {
      const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
      await mkdir(testRoot, { recursive: true });

      try {
        const saved = await saveTeamDefinition(testRoot, "Product Squad", "# Roles\n```json\n{}\n```");
        expect(saved.name).toBe("product-squad");
        expect(saved.scope).toBe("global");
        expect(saved.path).toBe(resolve(resolveGlobalTeamsDirectory(), "product-squad.json"));

        const listed = await listTeamDefinitions(testRoot);
        expect(listed).toHaveLength(1);
        expect(listed[0]!.name).toBe("product-squad");
        expect(listed[0]!.scope).toBe("global");

        const loaded = await loadTeamDefinition(testRoot, "Product Squad");
        expect(loaded.name).toBe("product-squad");
        expect(loaded.scope).toBe("global");
        expect(loaded.content).toContain("```json");

        const persisted = await readFile(saved.path, "utf8");
        expect(persisted.endsWith("\n")).toBe(true);
      } finally {
        await rm(testRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("lists global teams and lets local teams override by name", async () => {
    await withTempConfigHome(async () => {
      const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
      await mkdir(resolve(testRoot, ".kyros", "teams"), { recursive: true });

      try {
        await saveTeamDefinition(testRoot, "api", "{\"orchestrator\":{},\"coworkers\":[]}", "global");
        await saveTeamDefinition(testRoot, "qa", "{\"orchestrator\":{},\"coworkers\":[]}", "global");
        await writeFile(
          resolve(testRoot, ".kyros", "teams", "api.json"),
          "{\"orchestrator\":{\"name\":\"Local API\"},\"coworkers\":[]}",
          "utf8",
        );

        const listed = await listTeamDefinitions(testRoot);
        expect(listed.map((team) => `${team.name}:${team.scope}`)).toEqual(["api:local", "qa:global"]);

        const loaded = await loadTeamDefinition(testRoot, "api");
        expect(loaded.scope).toBe("local");
        expect(loaded.content).toContain("Local API");
      } finally {
        await rm(testRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("loads legacy markdown team definitions when no json file exists", async () => {
    await withTempConfigHome(async () => {
      const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
      const legacyPath = resolve(testRoot, ".kyros", "teams", "legacy.md");
      await mkdir(resolve(testRoot, ".kyros", "teams"), { recursive: true });

      try {
        await writeFile(legacyPath, "# Roles\n```json\n{}\n```", "utf8");

        const loaded = await loadTeamDefinition(testRoot, "legacy");
        expect(loaded.path).toBe(legacyPath);
        expect(loaded.scope).toBe("local");
      } finally {
        await rm(testRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("prefers json team definitions over newer legacy markdown files", async () => {
    await withTempConfigHome(async () => {
      const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
      const teamsDir = resolve(testRoot, ".kyros", "teams");
      const jsonPath = resolve(teamsDir, "api.json");
      const markdownPath = resolve(teamsDir, "api.md");
      await mkdir(teamsDir, { recursive: true });

      try {
        await writeFile(jsonPath, "{\"orchestrator\":{\"name\":\"JSON\"},\"coworkers\":[]}", "utf8");
        await writeFile(markdownPath, "# Legacy\n```json\n{\"orchestrator\":{\"name\":\"Markdown\"},\"coworkers\":[]}\n```", "utf8");
        await utimes(jsonPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
        await utimes(markdownPath, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

        const listed = await listTeamDefinitions(testRoot);
        expect(listed).toHaveLength(1);
        expect(listed[0]!.path).toBe(jsonPath);

        const loaded = await loadTeamDefinition(testRoot, "api");
        expect(loaded.path).toBe(jsonPath);
        expect(loaded.content).toContain("JSON");
      } finally {
        await rm(testRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("detects a prepared project team context", async () => {
    const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
    await mkdir(resolve(testRoot, ".kyros"), { recursive: true });

    try {
      await Promise.all([
        writeFile(resolve(testRoot, ".kyros", "goal.md"), "# Goal\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "plan.md"), "# Plan\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "spec.md"), "# Spec\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "tasks.md"), "- [ ] First task\n", "utf8"),
        writeFile(resolve(testRoot, ".kyros", "roles.json"), "{\"orchestrator\":{},\"coworkers\":[]}\n", "utf8"),
      ]);

      await expect(hasProjectTeamContext(testRoot)).resolves.toBe(true);
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("detects legacy root project files for existing folders", async () => {
    const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      await Promise.all([
        writeFile(resolve(testRoot, "goal.md"), "# Goal\n", "utf8"),
        writeFile(resolve(testRoot, "plan.md"), "# Plan\n", "utf8"),
        writeFile(resolve(testRoot, "spec.md"), "# Spec\n", "utf8"),
        writeFile(resolve(testRoot, "tasks.md"), "- [ ] First task\n", "utf8"),
        writeFile(resolve(testRoot, "roles.json"), "{\"orchestrator\":{},\"coworkers\":[]}\n", "utf8"),
      ]);

      await expect(hasProjectTeamContext(testRoot)).resolves.toBe(true);
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("requires the full kyros project context before auto team mode can activate", async () => {
    const testRoot = resolve(tmpdir(), `team-storage-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });

    try {
      await Promise.all([
        writeFile(resolve(testRoot, "goal.md"), "# Goal\n", "utf8"),
        writeFile(resolve(testRoot, "plan.md"), "# Plan\n", "utf8"),
        writeFile(resolve(testRoot, "spec.md"), "# Spec\n", "utf8"),
        writeFile(resolve(testRoot, "roles.json"), "{\"orchestrator\":{},\"coworkers\":[]}\n", "utf8"),
      ]);

      await expect(hasProjectTeamContext(testRoot)).resolves.toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
