import { describe, it, expect } from "vitest";
import {
  parseTeamConfig,
  parseTasks,
  applyTaskUpdates,
  persistTasks,
  extractResponseJson,
  loadTeamProject,
  parseAgentTurnJson,
  readAgentTurnResponse,
} from "../runtime.js";
import type {
  TeamDefinition,
  LoadedTeamProject,
  ProjectContextFiles,
  TeamTask,
  AgentTaskUpdate,
  TeamMemberDefinition,
} from "../types.js";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const responseTestMember: TeamMemberDefinition = {
  id: "builder",
  name: "Builder",
  role: "Coworker",
  provider: "codex",
  cwd: tmpdir(),
  isOrchestrator: false,
};

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

describe("parseTeamConfig", () => {
  it("parses a valid team config with orchestrator and coworkers", () => {
    const markdown = `
# Roles

Some description.

\`\`\`json
{
  "orchestrator": {
    "name": "John",
    "description": "Coordinates the build and delegates work.",
    "provider": "codex",
    "model": "gpt-5.1-codex-mini"
  },
  "coworkers": [
    {
      "name": "Steve",
      "description": "Builds backend APIs and data flows.",
      "provider": "claudeCode",
      "model": "sonnet"
    }
  ]
}
\`\`\`
`;
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.orchestrator!).toBeDefined();
    expect(result.orchestrator!.name).toBe("John");
    expect(result.orchestrator!.provider).toBe("codex");
    expect(result.coworkers).toHaveLength(1);
    expect(result.coworkers[0]!.name).toBe("Steve");
    expect(result.runtime.maxTurns).toBe(18); // default
    expect(result.runtime.maxIdleTurns).toBe(2); // default
    expect(result.runtime.stopWhenTasksComplete).toBe(true); // default
    expect(result.runtime.maxTurnDurationMs).toBeUndefined(); // no default turn timeout
  });

  it("parses runtime config overrides", () => {
    const markdown = `
\`\`\`json
{
  "orchestrator": { "name": "J", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
  "coworkers": [{ "name": "S", "description": "Implements backend work.", "provider": "claudeCode", "model": "sonnet" }],
  "runtime": {
    "maxTurns": 10,
    "maxIdleTurns": 3,
    "stopWhenTasksComplete": false,
    "maxConcurrentAgents": 2,
    "maxTurnDurationMs": 300000
  }
}
\`\`\`
`;
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.runtime.maxTurns).toBe(10);
    expect(result.runtime.maxIdleTurns).toBe(3);
    expect(result.runtime.stopWhenTasksComplete).toBe(false);
    expect(result.runtime.maxConcurrentAgents).toBe(2);
    expect(result.runtime.maxTurnDurationMs).toBe(300000);
  });

  it("throws if no orchestrator defined", () => {
    const markdown = `
\`\`\`json
{
  "coworkers": [{ "name": "S", "description": "Implements backend work.", "provider": "claudeCode", "model": "sonnet" }]
}
\`\`\`
`;
    expect(() => parseTeamConfig(markdown, "/tmp/cwd")).toThrow("must define an orchestrator");
  });

  it("throws if no coworkers defined", () => {
    const markdown = `
\`\`\`json
{
  "orchestrator": { "name": "J", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" }
}
\`\`\`
`;
    expect(() => parseTeamConfig(markdown, "/tmp/cwd")).toThrow("at least one coworker");
  });

  it("normalizes member ids to slugified unique values", () => {
    const markdown = `
\`\`\`json
{
  "orchestrator": { "name": "John Doe", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
  "coworkers": [
    { "name": "Steve", "description": "Builds backend work.", "provider": "claudeCode", "model": "sonnet" },
    { "name": "steve", "description": "Builds backend work.", "provider": "claudeCode", "model": "sonnet" }
  ]
}
\`\`\`
`;
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.orchestrator!.id).toBe("john-doe");
    expect(result.coworkers[0]!.id).toBe("steve");
    expect(result.coworkers[1]!.id).toBe("steve-2"); // duplicate name handled
  });

  it("requires explicit models when strict mode is enabled", () => {
    const markdown = `
\`\`\`json
{
  "orchestrator": { "name": "John", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
  "coworkers": [
    { "name": "Steve", "provider": "claudeCode" }
  ]
}
\`\`\`
`;

    expect(() => parseTeamConfig(markdown, "/tmp/cwd", { requireModels: true })).toThrow("needs a model");
  });

  it("requires explicit descriptions when strict mode is enabled", () => {
    const markdown = `
\`\`\`json
{
  "orchestrator": { "name": "John", "description": "Coordinates delivery.", "provider": "codex", "model": "gpt-5.4" },
  "coworkers": [
    { "name": "Steve", "provider": "claudeCode", "model": "sonnet" }
  ]
}
\`\`\`
`;

    expect(() => parseTeamConfig(markdown, "/tmp/cwd", { requireDescriptions: true })).toThrow("needs a description");
  });
});

describe("parseTasks", () => {
  it("parses unchecked tasks as todo", () => {
    const markdown = `
# Tasks

- [ ] First task
- [ ] Second task
`;
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.status).toBe("todo");
    expect(tasks[0]!.checked).toBe(false);
    expect(tasks[1]!.title).toBe("Second task");
  });

  it("parses checked tasks as done", () => {
    const markdown = `
- [x] Completed task
- [X] Another done
`;
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[1]!.status).toBe("done");
  });

  it("ignores non-task lines", () => {
    const markdown = `
# Header

Some paragraph.

- [ ] Real task

Not a task line.
`;
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Real task");
  });

  it("generates unique ids based on title and line index", () => {
    const markdown = "- [ ] Foo\n- [ ] Bar\n";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.id).toMatch(/^task-01-foo$/);
    expect(tasks[1]!.id).toMatch(/^task-02-bar$/);
  });
});

describe("applyTaskUpdates", () => {
  it("applies status changes and marks checked accordingly", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0 },
      { id: "task-2", title: "Task 2", checked: false, status: "todo", lineIndex: 1 },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "in_progress" },
      { taskId: "task-2", status: "done" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(true);
    expect(tasks[0]!.status).toBe("in_progress");
    expect(tasks[0]!.checked).toBe(false);
    expect(tasks[1]!.status).toBe("done");
    expect(tasks[1]!.checked).toBe(true);
  });

  it("applies assignee and note updates", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0, assignee: undefined, note: undefined },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "todo", assignee: "steve", note: "Working on it" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(true);
    expect(tasks[0]!.assignee).toBe("steve");
    expect(tasks[0]!.note).toBe("Working on it");
  });

  it("returns false if no matching task ids", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0 },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "non-existent", status: "done" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(false);
  });

  it("applies updates addressed by task ordinal shorthand", () => {
    const tasks: TeamTask[] = [
      { id: "task-01-build-map", title: "Build map", checked: false, status: "todo", lineIndex: 0 },
      { id: "task-16-add-combat", title: "Add combat", checked: false, status: "todo", lineIndex: 15 },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "in_progress" },
      { taskId: "task-16", status: "done" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(true);
    expect(tasks[0]!.status).toBe("in_progress");
    expect(tasks[1]!.status).toBe("done");
    expect(tasks[1]!.checked).toBe(true);
  });

  it("returns false if updates do not change any field values", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: true, status: "done", lineIndex: 0, assignee: "steve" },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "done", assignee: "steve" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(false);
  });
});

describe("persistTasks", () => {
  it("writes updated checkboxes to tasks.md", async () => {
    const tempDir = tmpdir();
    const testFile = resolve(tempDir, `test-tasks-${Date.now()}.md`);
    const initialContent = "# Tasks\n\n- [ ] First task\n- [x] Second task\n- [ ] Third task\n";
    await writeFile(testFile, initialContent, "utf8");

    const project = {
      cwd: tempDir,
      teamSourcePath: "",
      paths: {
        goal: "",
        spec: "",
        plan: "",
        tasks: testFile,
        roles: "",
      },
      files: {
        goal: "",
        spec: "",
        plan: "",
        tasks: initialContent,
        roles: "",
      },
      team: {
        orchestrator: { id: "john", name: "John", provider: "codex", role: "Orchestrator", cwd: tempDir, isOrchestrator: true },
        coworkers: [],
        runtime: { maxTurns: 18, maxIdleTurns: 2, stopWhenTasksComplete: true, maxConcurrentAgents: 1 }
      },
      tasks: [
        { id: "task-1", title: "First task", checked: true, status: "done" as const, lineIndex: 2 },
        { id: "task-2", title: "Second task", checked: true, status: "done" as const, lineIndex: 3 },
        { id: "task-3", title: "Third task", checked: false, status: "todo" as const, lineIndex: 4 },
      ],
    } as LoadedTeamProject;

    await persistTasks(project);

    const updated = await readFile(testFile, "utf8");
    const taskLines = updated.split("\n").filter((line) => line.startsWith("- ["));
    expect(taskLines[0]).toMatch(/\[x\]/); // First task changed to done
    expect(taskLines[1]).toMatch(/\[x\]/); // Already done stays done
    expect(taskLines[2]).toMatch(/\[ \]/); // Third task stays todo
  });
});

describe("extractResponseJson", () => {
  it("extracts JSON from fenced code block", () => {
    const text = "Some intro\n```json\n{ \"summary\": \"test\" }\n```\nMore text";
    const result = extractResponseJson(text);
    expect(result).toBe('{ "summary": "test" }');
  });

  it("extracts JSON from fenced code block without language", () => {
    const text = "```\n{ \"done\": false }\n```";
    const result = extractResponseJson(text);
    expect(result).toBe('{ "done": false }');
  });

  it("extracts raw JSON object when it starts and ends with braces", () => {
    const text = "{ \"deliveries\": [], \"taskUpdates\": [] }";
    const result = extractResponseJson(text);
    expect(result).toBe("{ \"deliveries\": [], \"taskUpdates\": [] }");
  });

  it("extracts JSON from text with braces embedded", () => {
    const text = "Here is the response: { \"summary\": \"ok\" } and that's it.";
    const result = extractResponseJson(text);
    expect(result).toBe("{ \"summary\": \"ok\" }");
  });

  it("throws when no JSON object is found", () => {
    const text = "No JSON here, just plain text.";
    expect(() => extractResponseJson(text)).toThrow("No JSON object found");
  });

  it("extracts JSON with nested braces", () => {
    const text = "```json\n{ \"context\": { \"nested\": true } }\n```";
    const result = extractResponseJson(text);
    expect(result).toBe('{ "context": { "nested": true } }');
  });
});

describe("parseAgentTurnJson", () => {
  it("normalizes raw JSON turn responses", () => {
    const result = parseAgentTurnJson(
      JSON.stringify({
        summary: "finished slice",
        done: true,
        deliveries: [{
          to: "orchestrator",
          kind: "update",
          text: "Ready for review",
          taskIds: ["task-1"],
          payload: {
            files: ["src/app.ts"],
            priority: "high",
            dependencies: ["task-0"],
            acceptanceCriteria: ["tests pass"],
            context: { branch: "feature" },
          },
        }],
        taskUpdates: [{
          taskId: "task-1",
          status: "done",
          assignee: "builder",
          note: "Implemented",
        }],
      }),
      responseTestMember,
    );

    expect(result.summary).toBe("finished slice");
    expect(result.done).toBe(false);
    expect(result.deliveries?.[0]?.payload?.priority).toBe("high");
    expect(result.taskUpdates?.[0]?.status).toBe("done");
  });

  it("rejects malformed raw JSON", () => {
    expect(() => parseAgentTurnJson("{ invalid", responseTestMember)).toThrow("Invalid agent response JSON");
  });
});

describe("readAgentTurnResponse", () => {
  it("prefers the response file over final message text", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      const responseFilePath = resolve(testRoot, "response.json");
      await writeFile(responseFilePath, JSON.stringify({ summary: "from file" }), "utf8");

      const result = await readAgentTurnResponse({
        responseFilePath,
        finalText: "{ \"summary\": \"from chat\" }",
        member: responseTestMember,
      });

      expect(result.summary).toBe("from file");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("falls back to final message text when the response file is missing", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      const result = await readAgentTurnResponse({
        responseFilePath: resolve(testRoot, "missing.json"),
        finalText: "```json\n{ \"summary\": \"from chat\" }\n```",
        member: responseTestMember,
      });

      expect(result.summary).toBe("from chat");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("fails on malformed response file even when final message text is valid", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      const responseFilePath = resolve(testRoot, "response.json");
      await writeFile(responseFilePath, "{ invalid", "utf8");

      await expect(readAgentTurnResponse({
        responseFilePath,
        finalText: "{ \"summary\": \"from chat\" }",
        member: responseTestMember,
      })).rejects.toThrow("Invalid agent response JSON");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("parseTeamConfig edge cases", () => {
  it("throws on malformed JSON", () => {
    const markdown = "```json\n{ invalid json }\n```";
    expect(() => parseTeamConfig(markdown, "/tmp/cwd")).toThrow("JSON");
  });

  it("throws if JSON is not an object", () => {
    const markdown = "```json\n[]\n```";
    expect(() => parseTeamConfig(markdown, "/tmp/cwd")).toThrow("must be an object");
  });

  it("throws on unknown provider", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"unknown\" }] }\n```";
    expect(() => parseTeamConfig(markdown, "/tmp/cwd")).toThrow("Unsupported provider");
  });

  it("accepts coworkers with explicit ids", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\" }, \"coworkers\": [{ \"id\": \"special-id\", \"name\": \"S\", \"provider\": \"claudeCode\" }] }\n```";
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.coworkers[0]!.id).toBe("special-id");
  });

  it("resolves cwd to absolute path for members without explicit cwd", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"claudeCode\" }] }\n```";
    const result = parseTeamConfig(markdown, "/my/cwd");
    expect(result.orchestrator.cwd).toBe(resolve("/my/cwd"));
    expect(result.coworkers[0]!.cwd).toBe(resolve("/my/cwd"));
  });

  it("uses member-provided cwd when present", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\", \"cwd\": \"/custom\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"claudeCode\" }] }\n```";
    const result = parseTeamConfig(markdown, "/default");
    expect(result.orchestrator.cwd).toBe(resolve("/custom"));
  });

  it("clamps maxTurns and maxIdleTurns to at least 1", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"claudeCode\" }], \"runtime\": { \"maxTurns\": 0, \"maxIdleTurns\": 0 } }\n```";
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.runtime.maxTurns).toBe(1);
    expect(result.runtime.maxIdleTurns).toBe(1);
  });

  it("truncates numeric runtime values", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"claudeCode\" }], \"runtime\": { \"maxTurns\": 10.7, \"maxIdleTurns\": 3.9 } }\n```";
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.runtime.maxTurns).toBe(10);
    expect(result.runtime.maxIdleTurns).toBe(3);
  });

  it("accepts optional model and systemPrompt for members", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"J\", \"provider\": \"codex\", \"model\": \"custom-model\", \"systemPrompt\": \"You are an expert\" }, \"coworkers\": [{ \"name\": \"S\", \"provider\": \"claudeCode\" }] }\n```";
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.orchestrator.model).toBe("custom-model");
    expect(result.orchestrator.systemPrompt).toBe("You are an expert");
  });

  it("handles whitespace and special characters in names for slugification", () => {
    const markdown = "```json\n{ \"orchestrator\": { \"name\": \"  John   Doe  \", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"Steve!@#\", \"provider\": \"claudeCode\" }] }\n```";
    const result = parseTeamConfig(markdown, "/tmp/cwd");
    expect(result.orchestrator.id).toBe("john-doe");
    expect(result.coworkers[0]!.id).toBe("steve"); // special chars stripped
  });
});

describe("parseTasks edge cases", () => {
  it("handles empty tasks file", () => {
    const markdown = "";
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(0);
  });

  it("ignores lines without checkbox", () => {
    const markdown = "- just a list item\n- [ ] real task\n* [ ] another with star";
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("real task");
  });

  it("handles uppercase X checkbox", () => {
    const markdown = "- [X] Upper case done";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.checked).toBe(true);
  });

  it("trims whitespace around task titles", () => {
    const markdown = "- [ ]   leading and trailing   ";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.title).toBe("leading and trailing");
  });

  it("handles tasks with special characters in title", () => {
    const markdown = "- [ ] Task with `code` and **bold** and emoji 🎉";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.title).toBe("Task with `code` and **bold** and emoji 🎉");
  });

  it("handles tasks with unicode characters", () => {
    const markdown = "- [ ] 你好, привет, مرحبا";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.title).toBe("你好, привет, مرحبا");
  });

  it("generates ids based on line index, not task order", () => {
    const markdown = "# Header\n\nSome text.\n\n- [ ] First\n\n- [ ] Second";
    const tasks = parseTasks(markdown);
    // First task is at line 4 (0-indexed), so id uses 05
    expect(tasks[0]!.id).toMatch(/^task-05-first$/);
    // Second task is at line 6, so id uses 07
    expect(tasks[1]!.id).toMatch(/^task-07-second$/);
  });

  it("slugifies task titles with various punctuation", () => {
    const markdown = "- [ ] C++ & C# (coding)";
    const tasks = parseTasks(markdown);
    expect(tasks[0]!.id).toMatch(/^task-01-/);
  });
});

describe("applyTaskUpdates edge cases", () => {
  it("ignores updates with empty taskId", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0 },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "", status: "done" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(false);
    expect(tasks[0]!.status).toBe("todo");
  });

  // Note: applyTaskUpdates does not validate status values; callers should ensure valid statuses.
  // This test documents that invalid status will be set as-is (could corrupt state).
  it("applies whatever status is provided (no validation)", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0 },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "invalid" as any },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(true);
    expect(tasks[0]!.status).toBe("invalid"); // Not ideal, but that's current behavior
  });

  it("allows multiple updates on same task within same call", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: false, status: "todo", lineIndex: 0, assignee: undefined, note: undefined },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "in_progress", assignee: "steve" },
      { taskId: "task-1", status: "done", note: "Completed" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(true);
    expect(tasks[0]!.status).toBe("done");
    expect(tasks[0]!.assignee).toBe("steve");
    expect(tasks[0]!.note).toBe("Completed");
  });

  it("preserves existing fields when not updated", () => {
    const tasks: TeamTask[] = [
      { id: "task-1", title: "Task 1", checked: true, status: "done", lineIndex: 0, assignee: "mike", note: "Initial" },
    ];
    const updates: AgentTaskUpdate[] = [
      { taskId: "task-1", status: "done" },
    ];
    const changed = applyTaskUpdates(tasks, updates);
    expect(changed).toBe(false);
    expect(tasks[0]!.assignee).toBe("mike");
    expect(tasks[0]!.note).toBe("Initial");
  });
});

describe("loadTeamProject", () => {
  it("loads all project context files and parses them", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(resolve(testRoot, ".kyros"), { recursive: true });
    try {
      const testGoal = resolve(testRoot, ".kyros", "goal.md");
      const testSpec = resolve(testRoot, ".kyros", "spec.md");
      const testPlan = resolve(testRoot, ".kyros", "plan.md");
      const testTasks = resolve(testRoot, ".kyros", "tasks.md");
      const testRoles = resolve(testRoot, ".kyros", "roles.json");

      await Promise.all([
        writeFile(testGoal, "# Goal\nBuild something", "utf8"),
        writeFile(testSpec, "# Spec\nDetails here", "utf8"),
        writeFile(testPlan, "# Plan\nSteps", "utf8"),
        writeFile(testTasks, "# Tasks\n- [ ] Do work", "utf8"),
        writeFile(
          testRoles,
          "{ \"orchestrator\": { \"name\": \"J\", \"description\": \"Coordinates delivery.\", \"provider\": \"codex\", \"model\": \"gpt-5.4\" }, \"coworkers\": [{ \"name\": \"S\", \"description\": \"Implements backend work.\", \"provider\": \"claudeCode\", \"model\": \"sonnet\" }] }",
          "utf8",
        ),
      ]);

      const project = await loadTeamProject(testRoot);

      expect(project.cwd).toBe(testRoot);
      expect(project.paths.goal).toBe(testGoal);
      expect(project.paths.tasks).toBe(testTasks);
      expect(project.paths.roles).toBe(testRoles);
      expect(project.files.goal).toContain("Build something");
      expect(project.files.spec).toContain("Details here");
      expect(project.files.plan).toContain("Steps");
      expect(project.files.tasks).toContain("Do work");
      expect(project.files.roles).toContain("orchestrator");
      expect(project.team.orchestrator.name).toBe("J");
      expect(project.tasks).toHaveLength(1);
      expect(project.tasks[0]!.title).toBe("Do work");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("throws when required file is missing", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      // Create only some files
      await writeFile(resolve(testRoot, "goal.md"), "# Goal", "utf8");
      await writeFile(resolve(testRoot, "spec.md"), "# Spec", "utf8");
      await writeFile(resolve(testRoot, "plan.md"), "# Plan", "utf8");
      // Missing tasks.md and roles.json

      await expect(loadTeamProject(testRoot)).rejects.toThrow();
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects roles.json when any team member is missing a model", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      await Promise.all([
        writeFile(resolve(testRoot, "goal.md"), "# Goal\nBuild something", "utf8"),
        writeFile(resolve(testRoot, "spec.md"), "# Spec\nDetails here", "utf8"),
        writeFile(resolve(testRoot, "plan.md"), "# Plan\nSteps", "utf8"),
        writeFile(resolve(testRoot, "tasks.md"), "# Tasks\n- [ ] Do work", "utf8"),
        writeFile(
          resolve(testRoot, "roles.json"),
          "{ \"orchestrator\": { \"name\": \"Lead\", \"description\": \"Coordinates delivery.\", \"provider\": \"codex\", \"model\": \"gpt-5.4\" }, \"coworkers\": [{ \"name\": \"Builder\", \"description\": \"Builds backend work.\", \"provider\": \"claudeCode\" }] }",
          "utf8",
        ),
      ]);

      await expect(loadTeamProject(testRoot)).rejects.toThrow("needs a model");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("loads a named saved team from .kyros/teams", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(resolve(testRoot, ".kyros", "teams"), { recursive: true });
    try {
      await Promise.all([
        writeFile(resolve(testRoot, "goal.md"), "# Goal\nBuild something", "utf8"),
        writeFile(resolve(testRoot, "spec.md"), "# Spec\nDetails here", "utf8"),
        writeFile(resolve(testRoot, "plan.md"), "# Plan\nSteps", "utf8"),
        writeFile(resolve(testRoot, "tasks.md"), "# Tasks\n- [ ] Do work", "utf8"),
        writeFile(
          resolve(testRoot, ".kyros", "teams", "platform.json"),
          "{ \"orchestrator\": { \"name\": \"Lead\", \"description\": \"Coordinates delivery.\", \"provider\": \"codex\", \"model\": \"gpt-5.4\" }, \"coworkers\": [{ \"name\": \"Builder\", \"description\": \"Builds backend work.\", \"provider\": \"claudeCode\", \"model\": \"sonnet\" }] }",
          "utf8",
        ),
      ]);

      const project = await loadTeamProject(testRoot, "platform");

      expect(project.teamName).toBe("platform");
      expect(project.teamSourcePath).toBe(resolve(testRoot, ".kyros", "teams", "platform.json"));
      expect(project.paths.roles).toBe(resolve(testRoot, ".kyros", "teams", "platform.json"));
      expect(project.team.orchestrator.name).toBe("Lead");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("loads a named saved team from the global config directory", async () => {
    await withTempConfigHome(async (configHome) => {
      const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
      await mkdir(resolve(configHome, "kyros", "teams"), { recursive: true });
      await mkdir(testRoot, { recursive: true });
      try {
        await Promise.all([
          writeFile(resolve(testRoot, "goal.md"), "# Goal\nBuild something", "utf8"),
          writeFile(resolve(testRoot, "spec.md"), "# Spec\nDetails here", "utf8"),
          writeFile(resolve(testRoot, "plan.md"), "# Plan\nSteps", "utf8"),
          writeFile(resolve(testRoot, "tasks.md"), "# Tasks\n- [ ] Do work", "utf8"),
          writeFile(
            resolve(configHome, "kyros", "teams", "api.json"),
            "{ \"orchestrator\": { \"name\": \"API Lead\", \"description\": \"Coordinates API delivery.\", \"provider\": \"codex\", \"model\": \"gpt-5.4\" }, \"coworkers\": [{ \"name\": \"API Builder\", \"description\": \"Builds API work.\", \"provider\": \"claudeCode\", \"model\": \"sonnet\" }] }",
            "utf8",
          ),
        ]);

        const project = await loadTeamProject(testRoot, "api");

        expect(project.teamName).toBe("api");
        expect(project.teamSourcePath).toBe(resolve(configHome, "kyros", "teams", "api.json"));
        expect(project.paths.roles).toBe(resolve(configHome, "kyros", "teams", "api.json"));
        expect(project.team.orchestrator.name).toBe("API Lead");
      } finally {
        await rm(testRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("falls back to legacy roles.md when roles.json is absent", async () => {
    const testRoot = resolve(tmpdir(), `test-${randomUUID()}`);
    await mkdir(testRoot, { recursive: true });
    try {
      await Promise.all([
        writeFile(resolve(testRoot, "goal.md"), "# Goal\nBuild something", "utf8"),
        writeFile(resolve(testRoot, "spec.md"), "# Spec\nDetails here", "utf8"),
        writeFile(resolve(testRoot, "plan.md"), "# Plan\nSteps", "utf8"),
        writeFile(resolve(testRoot, "tasks.md"), "# Tasks\n- [ ] Do work", "utf8"),
        writeFile(
          resolve(testRoot, "roles.md"),
          "# Roles\n```json\n{ \"orchestrator\": { \"name\": \"Lead\", \"provider\": \"codex\" }, \"coworkers\": [{ \"name\": \"Builder\", \"provider\": \"claudeCode\" }] }\n```",
          "utf8",
        ),
      ]);

      const project = await loadTeamProject(testRoot);

      expect(project.paths.roles).toBe(resolve(testRoot, "roles.md"));
      expect(project.team.orchestrator.name).toBe("Lead");
    } finally {
      await rm(testRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
