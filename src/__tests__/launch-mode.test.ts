import { describe, expect, it } from "vitest";
import { shouldRunTeamMode } from "../launch-mode.js";

describe("shouldRunTeamMode", () => {
  it("honors an explicit team flag", () => {
    expect(shouldRunTeamMode({
      explicitTeam: true,
      explicitProvider: true,
      hasProjectTeamContext: false,
    })).toBe(true);
  });

  it("auto-enters team mode for prepared kyros folders when no provider is forced", () => {
    expect(shouldRunTeamMode({
      explicitTeam: false,
      explicitProvider: false,
      hasProjectTeamContext: true,
    })).toBe(true);
  });

  it("stays in single-agent mode when a provider is explicitly chosen", () => {
    expect(shouldRunTeamMode({
      explicitTeam: false,
      explicitProvider: true,
      hasProjectTeamContext: true,
    })).toBe(false);
  });
});
