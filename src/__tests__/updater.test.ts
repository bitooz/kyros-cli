import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkForUpdate, compareVersions, maybeNotifyUpdate, runUpdateCommand, shouldRunStartupUpdateCheck } from "../updater.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("updater", () => {
  it("compares semantic versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("checks a release manifest for updates", async () => {
    const result = await checkForUpdate({
      currentVersion: "0.1.1",
      manifestUrl: "https://updates.example.com/kyros.json",
      fetchImpl: async () => jsonResponse({
        version: "0.2.0",
        notesUrl: "https://github.com/bitooz/kyros-cli/releases/tag/v0.2.0",
      }),
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("0.2.0");
    expect(result.manifest.notesUrl).toContain("v0.2.0");
  });

  it("prints installer details for a dry-run update", async () => {
    let output = "";

    await runUpdateCommand(
      {
        currentVersion: "0.1.1",
        dryRun: true,
        manifestUrl: "https://updates.example.com/kyros.json",
      },
      {
        stdout: {
          write: (chunk) => {
            output += chunk;
          },
        },
        fetchImpl: async () => jsonResponse({
          version: "0.2.0",
          installer: {
            url: "https://updates.example.com/install.sh",
            args: ["--cli"],
          },
        }),
      },
    );

    expect(output).toContain("Update available: 0.1.1 -> 0.2.0");
    expect(output).toContain("Would run installer: https://updates.example.com/install.sh --cli");
  });

  it("downloads and runs the installer script when updating", async () => {
    let ranScript = "";
    let ranArgs: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("install.sh")) {
        return new Response("echo installing kyros\n");
      }
      return jsonResponse({
        version: "0.2.0",
        installer: {
          url: "https://updates.example.com/install.sh",
          args: ["--cli"],
        },
      });
    };

    await runUpdateCommand(
      {
        currentVersion: "0.1.1",
        manifestUrl: "https://updates.example.com/kyros.json",
      },
      {
        fetchImpl,
        runInstaller: async (script, args) => {
          ranScript = script;
          ranArgs = args;
          return 0;
        },
        stdout: {
          write: () => {},
        },
      },
    );

    expect(ranScript).toBe("echo installing kyros\n");
    expect(ranArgs).toEqual(["--cli"]);
  });

  it("rate-limits startup update checks", async () => {
    const testRoot = await mkdtemp(resolve(tmpdir(), "kyros-updater-"));

    try {
      const env = {
        XDG_CONFIG_HOME: resolve(testRoot, ".config"),
      };
      const fetchImpl = async () => jsonResponse({
        version: "0.2.0",
      });

      const first = await maybeNotifyUpdate({
        currentVersion: "0.1.1",
        env,
        fetchImpl,
        manifestUrl: "https://updates.example.com/kyros.json",
        now: new Date("2026-05-08T00:00:00Z"),
        writer: {
          write: () => {},
        },
      });
      const second = await maybeNotifyUpdate({
        currentVersion: "0.1.1",
        env,
        fetchImpl,
        manifestUrl: "https://updates.example.com/kyros.json",
        now: new Date("2026-05-08T01:00:00Z"),
        writer: {
          write: () => {},
        },
      });

      expect(first.checked).toBe(true);
      expect(second.checked).toBe(false);
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("skips startup checks in noninteractive or disabled environments", () => {
    expect(shouldRunStartupUpdateCheck({
      argv: [],
      stdinIsTTY: false,
      stderrIsTTY: true,
    })).toBe(false);
    expect(shouldRunStartupUpdateCheck({
      argv: [],
      env: { KYROS_NO_UPDATE_CHECK: "1" },
      stdinIsTTY: true,
      stderrIsTTY: true,
    })).toBe(false);
    expect(shouldRunStartupUpdateCheck({
      argv: ["task"],
      stdinIsTTY: true,
      stderrIsTTY: true,
    })).toBe(true);
  });
});
