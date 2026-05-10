import { describe, expect, it } from "vitest";
import {
  looksLikeNarrativeDocumentSummary,
  looksLikeStructuredDocumentDraft,
  normalizeDocumentDraft,
  setRolesMemberModel,
  setRolesProviderModel,
  summarizeRolesMemberModels,
  summarizeRolesModels,
} from "./documents.js";

describe("normalizeDocumentDraft", () => {
  it("keeps normal markdown stages as-is", () => {
    expect(normalizeDocumentDraft("goal", "# Goal\n\nBuild a thing", "/tmp/project")).toBe("# Goal\n\nBuild a thing");
  });

  it("does not unwrap inner fenced code blocks from markdown documents", () => {
    const draft = normalizeDocumentDraft(
      "plan",
      `# Plan

## Example

\`\`\`sql
select 1;
\`\`\`
`,
      "/tmp/project",
    );

    expect(draft).toContain("# Plan");
    expect(draft).toContain("```sql");
    expect(draft).toContain("select 1;");
  });

  it("detects structured markdown drafts", () => {
    expect(looksLikeStructuredDocumentDraft("goal", "# Goal\n\nBuild a thing")).toBe(true);
    expect(looksLikeStructuredDocumentDraft("tasks", "- [ ] Build a thing")).toBe(true);
  });

  it("detects narrative summaries that should not be saved as docs", () => {
    expect(looksLikeNarrativeDocumentSummary("Let me first explore the codebase before writing goal.md.")).toBe(true);
    expect(looksLikeNarrativeDocumentSummary("goal.md has been written. Ready to proceed.")).toBe(true);
    expect(looksLikeNarrativeDocumentSummary("# Goal\n\nBuild a thing")).toBe(false);
  });

  it("normalizes roles markdown with a heading plus raw json object into fenced json", () => {
    const draft = normalizeDocumentDraft(
      "roles",
      `# Team Configuration

{
  "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4", "expertise": ["planning"] },
  "coworkers": [{ "name": "builder", "description": "Builds backend work.", "provider": "claudeCode", "model": "sonnet", "capabilities": ["api"] }]
}`,
      "/tmp/project",
      "claudeCode",
      { requireModels: true, requireDescriptions: true },
    );

    expect(draft.trim().startsWith("{")).toBe(true);
    expect(draft).toContain('"orchestrator"');
    expect(draft.trim().endsWith("}")).toBe(true);
    expect(draft).toContain('"provider": "claudeCode"');
    expect(draft).not.toContain('"expertise"');
    expect(draft).not.toContain('"capabilities"');
  });

  it("maps common runtime aliases to the supported runtime keys", () => {
    const draft = normalizeDocumentDraft(
      "roles",
      `{
        "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
        "coworkers": [{ "name": "builder", "description": "Builds backend work.", "provider": "claudeCode", "model": "sonnet" }],
        "runtime": { "parallelism": 3, "timeoutMinutes": 180 }
      }`,
      "/tmp/project",
      "claudeCode",
      { requireModels: true, requireDescriptions: true },
    );

    expect(draft).toContain('"maxConcurrentAgents": 3');
    expect(draft).not.toContain('"maxTurns"');
    expect(draft).not.toContain('"timeoutMinutes"');
  });

  it("rejects roles drafts that omit a required model in strict mode", () => {
    expect(() =>
      normalizeDocumentDraft(
        "roles",
        `{
          "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
          "coworkers": [{ "name": "builder", "description": "Builds backend work.", "provider": "claudeCode" }]
        }`,
        "/tmp/project",
        "claudeCode",
        { requireModels: true, requireDescriptions: true },
      )
    ).toThrow("needs a model");
  });

  it("rejects roles drafts that omit a required description in strict mode", () => {
    expect(() =>
      normalizeDocumentDraft(
        "roles",
        `{
          "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
          "coworkers": [{ "name": "builder", "provider": "claudeCode", "model": "sonnet" }]
        }`,
        "/tmp/project",
        "claudeCode",
        { requireModels: true, requireDescriptions: true },
      )
    ).toThrow("needs a description");
  });

  it("summarizes team models by provider and model", () => {
    const summaries = summarizeRolesModels(
      `{
        "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
        "coworkers": [
          { "name": "builder", "description": "Builds backend work.", "provider": "claudeCode" },
          { "name": "reviewer", "description": "Reviews changes.", "provider": "claudeCode", "model": "sonnet" }
        ]
      }`,
      "/tmp/project",
      "claudeCode",
    );

    expect(summaries).toEqual([
      { provider: "claudeCode", model: undefined, members: ["builder"] },
      { provider: "claudeCode", model: "sonnet", members: ["reviewer"] },
      { provider: "codex", model: "gpt-5.4", members: ["lead"] },
    ]);
  });

  it("updates the model for all members using a provider", () => {
    const updated = setRolesProviderModel(
      `{
        "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex" },
        "coworkers": [
          { "name": "builder", "description": "Builds backend work.", "provider": "claudeCode" },
          { "name": "reviewer", "description": "Reviews changes.", "provider": "claudeCode", "model": "old" }
        ]
      }`,
      "/tmp/project",
      "claudeCode",
      "claudeCode",
      "sonnet",
    );

    expect(updated.updatedMembers).toEqual(["builder", "reviewer"]);
    expect(updated.content).toContain('"model": "sonnet"');
  });

  it("summarizes member models individually", () => {
    const summaries = summarizeRolesMemberModels(
      `{
        "orchestrator": { "name": "tech-lead", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
        "coworkers": [
          { "name": "backend-dev", "description": "Builds backend work.", "provider": "claudeCode" },
          { "name": "qa engineer", "description": "Verifies quality.", "provider": "claudeCode", "model": "sonnet" }
        ]
      }`,
      "/tmp/project",
      "claudeCode",
    );

    expect(summaries).toEqual([
      { id: "tech-lead", name: "tech-lead", provider: "codex", model: "gpt-5.4", isOrchestrator: true },
      { id: "backend-dev", name: "backend-dev", provider: "claudeCode", model: undefined, isOrchestrator: false },
      { id: "qa-engineer", name: "qa engineer", provider: "claudeCode", model: "sonnet", isOrchestrator: false },
    ]);
  });

  it("updates the model for one named member", () => {
    const updated = setRolesMemberModel(
      `{
        "orchestrator": { "name": "lead", "description": "Coordinates delivery.", "provider": "codex" },
        "coworkers": [
          { "name": "backend-dev", "description": "Builds backend work.", "provider": "claudeCode" },
          { "name": "qa engineer", "description": "Verifies quality.", "provider": "claudeCode", "model": "old" }
        ]
      }`,
      "/tmp/project",
      "claudeCode",
      "qa-engineer",
      "sonnet",
    );

    expect(updated.updatedMembers).toEqual(["qa engineer"]);
    expect(updated.content).toContain('"name": "qa engineer"');
    expect(updated.content).toContain('"model": "sonnet"');
    expect(updated.content).not.toContain('"name": "backend-dev",\n      "description": "Builds backend work.",\n      "provider": "claudeCode",\n      "model": "sonnet"');
  });
});
