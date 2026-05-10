import {
  getAdapter,
  registerBuiltinAdapters,
  type AdapterEvent,
  type AdapterSession,
  type AdapterSessionConfig,
  type AdapterProvider,
} from "../adapters/index.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { stdout } from "node:process";
import {
  loadTeamDefinition,
  resolveExistingProjectContextPath,
  resolveProjectDirectory,
  resolveProjectTeamConfigPath,
} from "./storage.js";
import type {
  AgentTaskUpdate,
  AgentTurnResponse,
  DeliveryPayload,
  LoadedTeamProject,
  ProjectContextFiles,
  TeamDeliveryKind,
  TeamMemberDefinition,
  TeamMessage,
  TeamRunOptions,
  TeamRunResult,
  TeamRuntimeEvent,
  TeamRuntimeEventHandler,
  TeamTask,
  TeamTaskStatus,
  TeamRunRecord,
  TeamMessageRecord,
  TeamTaskRecord,
} from "./types.js";

const PROJECT_FILES = ["goal", "spec", "plan", "tasks", "roles"] as const;
const DEFAULT_MAX_TURNS = 18;
const DEFAULT_MAX_IDLE_TURNS = 2;
const RECENT_MESSAGE_LIMIT = 12;
const RESPONSE_ATTEMPT_PAD = 2;
const TURN_NUMBER_PAD = 4;
const MAX_TRANSIENT_PROVIDER_FAILURES = 2;

interface ParsedTeamConfig {
  orchestrator: Record<string, unknown>;
  coworkers: Array<Record<string, unknown>>;
  runtime?: Record<string, unknown>;
}

interface AgentState {
  member: TeamMemberDefinition;
  session: AdapterSession;
  bootstrapped: boolean;
  retryCount: number; // Number of consecutive invalid JSON responses
  transientFailureCount: number;
}

interface AgentStreamState {
  textOpen: boolean;
  streamedText: string;
  providerToolCalls?: Map<string, { name: string; input: Record<string, unknown> }>;
}

interface OutputState {
  enabled: boolean;
  openAgentId: string | null;
  openStreamState: AgentStreamState | null;
}

interface RuntimeLifecycleState {
  stopping: boolean;
}

interface SuccessfulCompletedAgentTurn {
  agent: TeamMemberDefinition;
  response: AgentTurnResponse;
  turnNumber: number;
}

interface FailedCompletedAgentTurn {
  agent: TeamMemberDefinition;
  error: string;
  turnNumber: number;
  retryMessages: TeamMessage[];
}

type CompletedAgentTurn = SuccessfulCompletedAgentTurn | FailedCompletedAgentTurn;

interface AgentTurnResponseReadInput {
  responseFilePath: string;
  finalText: string;
  member: TeamMemberDefinition;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isProvider(value: string | undefined): value is AdapterProvider {
  return value === "claudeCode" || value === "codex" || value === "opencode";
}

function slugify(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "agent";
}

function appendOnlyDelta(existing: string, incoming: string): string {
  if (!incoming) {
    return "";
  }

  if (!existing) {
    return incoming;
  }

  if (incoming === existing) {
    return "";
  }

  if (incoming.startsWith(existing)) {
    return incoming.slice(existing.length);
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return incoming.slice(overlap);
    }
  }

  return incoming;
}

function uniqueId(base: string, seen: Set<string>): string {
  let candidate = slugify(base);
  let counter = 2;
  while (seen.has(candidate)) {
    candidate = `${slugify(base)}-${counter}`;
    counter += 1;
  }
  seen.add(candidate);
  return candidate;
}

function normalizeMemberOverrideKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractJsonBlock(markdown: string): string {
  const fencedMatch = markdown.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const trimmed = markdown.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  throw new Error("Team config must contain a JSON object or fenced JSON block.");
}

function normalizeMember(input: {
  raw: Record<string, unknown>;
  cwd: string;
  fallbackRole: string;
  isOrchestrator: boolean;
  usedIds: Set<string>;
  requireModel?: boolean;
  requireDescription?: boolean;
}): TeamMemberDefinition {
  const name = asString(input.raw.name);
  const description = asString(input.raw.description) ?? asString(input.raw.role);
  const provider = asString(input.raw.provider);
  const model = asString(input.raw.model);
  if (!name) {
    throw new Error("Every team member needs a name in the team config.");
  }
  if (input.requireDescription && !description) {
    throw new Error(`Every team member needs a description in the team config. Missing description for ${name}.`);
  }
  if (!isProvider(provider)) {
    throw new Error(`Unsupported provider "${provider ?? "unknown"}" for ${name}.`);
  }
  if (input.requireModel && !model) {
    throw new Error(`Every team member needs a model in the team config. Missing model for ${name}.`);
  }

  const explicitId = asString(input.raw.id);
  const id = uniqueId(explicitId ?? name, input.usedIds);

  return {
    id,
    name,
    role: asString(input.raw.role) ?? input.fallbackRole,
    description,
    provider,
    model,
    systemPrompt: asString(input.raw.systemPrompt),
    cwd: resolve(asString(input.raw.cwd) ?? input.cwd),
    isOrchestrator: input.isOrchestrator,
  };
}

export function parseTeamConfig(
  markdown: string,
  cwd: string,
  options?: { requireModels?: boolean; requireDescriptions?: boolean },
): LoadedTeamProject["team"] {
  const raw = JSON.parse(extractJsonBlock(markdown)) as unknown;
  const record = asRecord(raw);
  if (!record) {
    throw new Error("Team config JSON must be an object.");
  }

  const orchestratorRaw = asRecord(record.orchestrator);
  const coworkersRaw = Array.isArray(record.coworkers)
    ? record.coworkers.map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const runtimeRaw = asRecord(record.runtime);

  if (!orchestratorRaw) {
    throw new Error("Team config must define an orchestrator.");
  }
  if (coworkersRaw.length === 0) {
    throw new Error("Team config must define at least one coworker.");
  }

  const usedIds = new Set<string>();
  const orchestrator = normalizeMember({
    raw: orchestratorRaw,
    cwd,
    fallbackRole: "Orchestrator",
    isOrchestrator: true,
    usedIds,
    requireModel: options?.requireModels,
    requireDescription: options?.requireDescriptions,
  });
  const coworkers = coworkersRaw.map((rawMember) =>
    normalizeMember({
      raw: rawMember,
      cwd,
      fallbackRole: "Coworker",
      isOrchestrator: false,
      usedIds,
      requireModel: options?.requireModels,
      requireDescription: options?.requireDescriptions,
    })
  );

  return {
    orchestrator,
    coworkers,
    runtime: {
      maxTurns: Math.max(1, Math.trunc(asNumber(runtimeRaw?.maxTurns) ?? DEFAULT_MAX_TURNS)),
      maxIdleTurns: Math.max(1, Math.trunc(asNumber(runtimeRaw?.maxIdleTurns) ?? DEFAULT_MAX_IDLE_TURNS)),
      stopWhenTasksComplete: asBoolean(runtimeRaw?.stopWhenTasksComplete) ?? true,
      maxConcurrentAgents: Math.max(
        1,
        Math.trunc(asNumber(runtimeRaw?.maxConcurrentAgents) ?? (coworkers.length + 1)),
      ),
      maxTurnDurationMs: asNumber(runtimeRaw?.maxTurnDurationMs) === undefined
        ? undefined
        : Math.max(1_000, Math.trunc(asNumber(runtimeRaw?.maxTurnDurationMs)!)),
    },
  };
}

export function parseTasks(markdown: string): TeamTask[] {
  return markdown
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.*\S)\s*$/);
      if (!match) {
        return [];
      }

      const checked = match[1] !== " ";
      const title = match[2]!.trim();
      const ordinal = String(index + 1).padStart(2, "0");
      return [{
        id: `task-${ordinal}-${slugify(title)}`,
        title,
        checked,
        status: checked ? "done" : "todo",
        lineIndex: index,
      } satisfies TeamTask];
    });
}

function formatTeamRoster(project: LoadedTeamProject): string {
  const members = [project.team.orchestrator, ...project.team.coworkers];
  return members
    .map((member) =>
      `- ${member.id}: ${member.name} | provider=${member.provider}${member.model ? ` | model=${member.model}` : ""}${member.description ? ` | description=${member.description}` : ""}`,
    )
    .join("\n");
}

function formatTaskSnapshot(tasks: TeamTask[]): string {
  if (tasks.length === 0) {
    return "- no tasks parsed from tasks.md";
  }

  return tasks
    .map((task) => {
      const extras = [
        task.assignee ? `assignee=${task.assignee}` : undefined,
        task.note ? `note=${task.note}` : undefined,
      ].filter(Boolean);
      return `- ${task.id} | ${task.status} | ${task.title}${extras.length > 0 ? ` | ${extras.join(" | ")}` : ""}`;
    })
    .join("\n");
}

function formatMessages(messages: TeamMessage[]): string {
  if (messages.length === 0) {
    return "- none";
  }

  return messages
    .map((message) => {
      const taskPart = message.taskIds.length > 0 ? ` [tasks: ${message.taskIds.join(", ")}]` : "";
      const payloadParts: string[] = [];
      if (message.payload) {
        if (message.payload.priority) {
          payloadParts.push(`priority=${message.payload.priority}`);
        }
        if (message.payload.files && message.payload.files.length > 0) {
          payloadParts.push(`files=${message.payload.files.join(",")}`);
        }
        if (message.payload.dependencies && message.payload.dependencies.length > 0) {
          payloadParts.push(`deps=${message.payload.dependencies.join(",")}`);
        }
        if (message.payload.acceptanceCriteria && message.payload.acceptanceCriteria.length > 0) {
          payloadParts.push(`criteria=${message.payload.acceptanceCriteria.length}`);
        }
      }
      const payloadPart = payloadParts.length > 0 ? ` {${payloadParts.join("; ")}}` : "";
      return `- ${message.from} -> ${message.to} (${message.kind})${taskPart}${payloadPart}: ${message.text}`;
    })
    .join("\n");
}

function buildProtocolPrompt(member: TeamMemberDefinition, orchestratorId: string): string {
  const doneRule = member.isOrchestrator
    ? "Set done=true only when the run should stop. This requests a graceful stop: no new turns will start, but teammates already running will be allowed to finish their current turn."
    : "Never set done=true. Only the orchestrator may finish the run.";
  const roleRule = member.isOrchestrator
    ? "You are coordinator-only. Inspect, delegate, ask for updates, resolve blockers, and decide completion. Do not implement code or edit files yourself."
    : "You are an implementing coworker. Do the assigned work, report progress, and collaborate with teammates.";

  return [
    `You are ${member.name} (${member.id}).`,
    "You are participating in the Kyros multi-agent runtime.",
    member.description ? `Specialization: ${member.description}` : undefined,
    roleRule,
    "Keep each turn short and collaborative. Make one focused slice of progress, then return control to the runtime.",
    "Communicate turn handoffs through the response JSON file that the runtime gives you. Do not ask the user via tool calls.",
    "Send a delivery to \"user\" with kind=\"question\" only when you are truly blocked and need an answer to continue. Use kind=\"update\" for informational user-visible notes that should not stop the run.",
    "Use exact task IDs from the task snapshot when referring to work items.",
    `The orchestrator is ${orchestratorId}.`,
    doneRule,
    "At the end of every turn, write exactly one raw JSON object to the response file path in the turn prompt. Do not wrap the file in markdown fences, and do not put protocol JSON in the chat response.",
    "If the session cannot write the file, return that same raw JSON object as the final chat response so the runtime can use its compatibility fallback.",
    "Expected schema:",
    "{",
    '  "summary": "short summary",',
    '  "done": false,',
    '  "deliveries": [',
    '    { "to": "agent-id|group|orchestrator|user", "kind": "task|update|question|answer|group", "text": "message text", "taskIds": ["task-id"],',
    '      "payload": { "files": ["path"], "priority": "high|medium|low", "dependencies": ["task-id"], "acceptanceCriteria": ["criterion"], "context": {} } }',
    "  ],",
    '  "taskUpdates": [',
    '    { "taskId": "task-id", "status": "todo|in_progress|done|blocked", "assignee": "agent-id", "note": "optional note" }',
    "  ]",
    "}",
    "The payload field is optional. Use it to attach structured assignment data: files (relevant paths), priority, dependencies (blocking task IDs), acceptanceCriteria (what to verify), and context (free-form domain data).",
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function buildProjectFilesSection(project: LoadedTeamProject): string {
  return [
    "Project context files:",
    "",
    "## goal.md",
    project.files.goal,
    "",
    "## spec.md",
    project.files.spec,
    "",
    "## plan.md",
    project.files.plan,
    "",
    "## tasks.md",
    project.files.tasks,
    "",
    `## ${basename(project.paths.roles)}`,
    project.files.roles,
  ].join("\n");
}

function buildTurnPrompt(input: {
  member: TeamMemberDefinition;
  project: LoadedTeamProject;
  unread: TeamMessage[];
  recentMessages: TeamMessage[];
  responseFilePath: string;
  steeringPrompt?: string;
  includeProjectFiles: boolean;
}): string {
  const sections = [
    input.includeProjectFiles ? buildProjectFilesSection(input.project) : undefined,
    "Team roster:",
    formatTeamRoster(input.project),
    "",
    "Current task snapshot:",
    formatTaskSnapshot(input.project.tasks),
    "",
    "Recent shared messages:",
    formatMessages(input.recentMessages),
    "",
    "Unread inbox messages for you:",
    formatMessages(input.unread),
    "",
    "Turn response file:",
    input.responseFilePath,
    "Write the expected raw JSON object to this exact absolute path before ending the turn. Keep the final chat response to a short confirmation after the file is written.",
    input.member.isOrchestrator && input.steeringPrompt
      ? `\nUser steering prompt:\n${input.steeringPrompt}`
      : undefined,
    "",
    "Produce the next structured response now.",
  ];

  return sections.filter((value): value is string => Boolean(value)).join("\n");
}

function buildRepairPrompt(responseFilePath: string, parseError: Error | null): string {
  return [
    `Your previous turn response could not be read as valid JSON${parseError ? `: ${parseError.message}` : "."}`,
    "Write ONLY a valid raw JSON object to this response file path:",
    responseFilePath,
    "",
    "Expected schema:",
    "{",
    '  "summary": "string",',
    '  "done": boolean,',
    '  "deliveries": [',
    '    { "to": "string", "kind": "task|update|question|answer|group", "text": "string", "taskIds": ["string"], "payload": { "files": ["path"], "priority": "high|medium|low", "dependencies": ["task-id"], "acceptanceCriteria": ["criterion"], "context": {} } }',
    "  ],",
    '  "taskUpdates": [',
    '    { "taskId": "string", "status": "todo|in_progress|done|blocked", "assignee": "string", "note": "string" }',
    "  ]",
    "}",
    "",
    "The payload field is optional. If you cannot write the file, return the same raw JSON object as the final chat response.",
  ].join("\n");
}

function closeOutputLine(outputState: OutputState): void {
  if (!outputState.openStreamState?.textOpen) {
    return;
  }

  if (outputState.enabled) {
    stdout.write("\n");
  }
  outputState.openStreamState.textOpen = false;
  outputState.openAgentId = null;
  outputState.openStreamState = null;
}

function closeTextLine(
  agentId: string,
  state: AgentStreamState,
  outputState: OutputState,
): void {
  if (!state.textOpen) {
    return;
  }

  if (outputState.openAgentId === agentId && outputState.openStreamState === state) {
    closeOutputLine(outputState);
    return;
  }

  state.textOpen = false;
}

function writeLogLine(
  prefix: string,
  message: string,
  outputState: OutputState,
): void {
  closeOutputLine(outputState);
  if (!outputState.enabled) {
    return;
  }
  stdout.write(`${prefix} ${message}\n`);
}

function writeRuntimeLine(message: string, outputState: OutputState): void {
  writeLogLine("[runtime]", message, outputState);
}

function writeTextDelta(
  prefix: string,
  agentId: string,
  text: string,
  state: AgentStreamState,
  outputState: OutputState,
): void {
  if (!text || !outputState.enabled) {
    return;
  }

  if (outputState.openAgentId !== agentId || outputState.openStreamState !== state || !state.textOpen) {
    closeOutputLine(outputState);
    stdout.write(`${prefix} `);
    outputState.openAgentId = agentId;
    outputState.openStreamState = state;
    state.textOpen = true;
  }

  stdout.write(text);
}

function emitTextDelta(
  prefix: string,
  agentId: string,
  text: string,
  state: AgentStreamState,
  outputState: OutputState,
  emit?: TeamRuntimeEventHandler,
): void {
  if (!text) {
    return;
  }

  state.streamedText += text;
  writeTextDelta(prefix, agentId, text, state, outputState);
  emit?.({ type: "agent.text.delta", agentId, text });
}

function emitCompletedTextFallback(
  prefix: string,
  agentId: string,
  text: string,
  state: AgentStreamState,
  outputState: OutputState,
  emit?: TeamRuntimeEventHandler,
): void {
  const delta = appendOnlyDelta(state.streamedText, text);
  if (!delta) {
    if (text) {
      state.streamedText = text;
    }
    return;
  }

  emitTextDelta(prefix, agentId, delta, state, outputState, emit);
  state.streamedText = text;
}

function summarizeEventValue(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
  } catch {
    return String(value);
  }
}

function getProviderToolCalls(
  state: AgentStreamState,
): Map<string, { name: string; input: Record<string, unknown> }> {
  if (!state.providerToolCalls) {
    state.providerToolCalls = new Map();
  }
  return state.providerToolCalls;
}

function summarizeClaudeToolResult(
  toolName: string,
  rawResult: unknown,
): string | undefined {
  const record = asRecord(rawResult);

  if (toolName === "Read") {
    const fileRecord = asRecord(record?.file);
    const filePath = asString(fileRecord?.filePath) ?? asString(record?.filePath);
    const numLines = asNumber(fileRecord?.numLines);
    if (filePath) {
      return `Read ${basename(filePath)}${numLines ? ` (${numLines} lines)` : ""}`;
    }
  }

  const filePath = asString(record?.filePath);
  if (filePath) {
    return `${toolName === "Write" ? "Wrote" : "Updated"} ${basename(filePath)}`;
  }

  const stdoutText = asString(record?.stdout);
  const stderrText = asString(record?.stderr);
  const firstOutput = stdoutText?.split("\n")[0] ?? stderrText?.split("\n")[0];
  if (firstOutput) {
    return firstOutput;
  }

  const content = Array.isArray(record?.content) ? record.content : [];
  for (const entry of content) {
    const block = asRecord(entry);
    const text = asString(block?.text);
    if (text) {
      return text.split("\n")[0];
    }
  }

  return undefined;
}

function emitClaudeProviderEvent(
  agentId: string,
  payload: unknown,
  state: AgentStreamState,
  emit?: TeamRuntimeEventHandler,
): void {
  const record = asRecord(payload);
  const type = asString(record?.type);
  if (!record || !type) {
    return;
  }

  const toolCalls = getProviderToolCalls(state);

  if (type === "assistant") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block || asString(block.type) !== "tool_use") {
        continue;
      }

      const toolUseId = asString(block.id);
      const toolName = asString(block.name);
      const input = asRecord(block.input) ?? {};
      if (!toolName) {
        continue;
      }

      if (toolUseId) {
        toolCalls.set(toolUseId, { name: toolName, input });
      }

      emit?.({
        type: "agent.tool.use",
        agentId,
        tool: toolName,
        input,
      });
    }
    return;
  }

  if (type === "user") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block || asString(block.type) !== "tool_result") {
        continue;
      }

      const toolUseId = asString(block.tool_use_id);
      const call = toolUseId ? toolCalls.get(toolUseId) : undefined;
      const toolName = call?.name ?? "tool";
      const summary = summarizeClaudeToolResult(
        toolName,
        record.tool_use_result ?? block,
      );

      emit?.({
        type: "agent.tool.result",
        agentId,
        tool: toolName,
        output: summary ?? record.tool_use_result ?? block,
      });

      if (toolUseId) {
        toolCalls.delete(toolUseId);
      }
    }
  }
}

function shouldSuppressGenericToolUse(
  member: TeamMemberDefinition,
  tool: string,
  input: unknown,
): boolean {
  if (member.provider !== "claudeCode") {
    return false;
  }

  const record = asRecord(input);
  if (!record) {
    return false;
  }

  const keys = Object.keys(record);
  return keys.length > 0 && keys.every((key) => key === "toolUseId" || key === "taskId");
}

function handleAgentEvent(
  member: TeamMemberDefinition,
  event: AdapterEvent,
  state: AgentStreamState,
  outputState: OutputState,
  emit?: TeamRuntimeEventHandler,
): void {
  const prefix = `[${member.name}]`;

  switch (event.type) {
    case "session.started":
      writeLogLine(prefix, `session started (${event.provider}${event.model ? ` ${event.model}` : ""})`, outputState);
      emit?.({ type: "agent.session.started", agentId: member.id, provider: event.provider, model: event.model });
      break;
    case "status":
      writeLogLine(prefix, `${event.category}: ${event.message}`, outputState);
      emit?.({ type: "agent.status", agentId: member.id, category: event.category, message: event.message });
      break;
    case "text.delta":
      emitTextDelta(prefix, member.id, event.text, state, outputState, emit);
      break;
    case "thinking":
      writeLogLine(prefix, `thinking: ${event.text}`, outputState);
      emit?.({ type: "agent.thinking", agentId: member.id, text: event.text });
      break;
    case "tool.use":
      if (shouldSuppressGenericToolUse(member, event.tool, event.input)) {
        break;
      }
      writeLogLine(prefix, `tool ${event.tool}: ${summarizeEventValue(event.input)}`, outputState);
      emit?.({ type: "agent.tool.use", agentId: member.id, tool: event.tool, input: event.input });
      break;
    case "tool.result":
      writeLogLine(prefix, `tool-result ${event.tool}: ${summarizeEventValue(event.output)}`, outputState);
      emit?.({ type: "agent.tool.result", agentId: member.id, tool: event.tool, output: event.output });
      break;
    case "command":
      writeLogLine(prefix, `command ${event.command} (exit ${event.exitCode})`, outputState);
      emit?.({ type: "agent.command", agentId: member.id, command: event.command, exitCode: event.exitCode, output: event.output });
      break;
    case "file.change":
      writeLogLine(prefix, `file ${event.kind}: ${event.path}`, outputState);
      emit?.({ type: "agent.file.change", agentId: member.id, kind: event.kind, path: event.path });
      break;
    case "permission.request":
      writeLogLine(prefix, `permission requested for ${event.request.tool}`, outputState);
      emit?.({ type: "agent.permission", agentId: member.id, tool: event.request.tool });
      break;
    case "question":
      writeLogLine(prefix, "adapter-level question requested; team runtime expects deliveries instead", outputState);
      break;
    case "error":
      writeLogLine(prefix, `error: ${event.error}`, outputState);
      emit?.({ type: "agent.error", agentId: member.id, message: event.error });
      break;
    case "provider.event":
      if (member.provider === "claudeCode") {
        emitClaudeProviderEvent(member.id, event.data, state, emit);
      }
      break;
    case "message.completed":
      emitCompletedTextFallback(prefix, member.id, event.text, state, outputState, emit);
      break;
    case "completed":
      emitCompletedTextFallback(prefix, member.id, event.result.text, state, outputState, emit);
      break;
  }
}

export function extractResponseJson(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("No JSON object found in agent response.");
}

function buildTurnResponseFilePath(
  member: TeamMemberDefinition,
  runId: string,
  turnNumber: number,
  attempt: number,
): string {
  const turn = String(turnNumber).padStart(TURN_NUMBER_PAD, "0");
  const attemptId = String(attempt).padStart(RESPONSE_ATTEMPT_PAD, "0");
  return resolve(
    member.cwd,
    ".kyros",
    "runtime",
    "responses",
    runId,
    `turn-${turn}-${member.id}-attempt-${attemptId}.json`,
  );
}

function normalizeTaskStatus(value: string | undefined): TeamTaskStatus | undefined {
  switch (value) {
    case "todo":
    case "in_progress":
    case "done":
    case "blocked":
      return value;
    default:
      return undefined;
  }
}

function normalizePayload(raw: Record<string, unknown> | undefined): DeliveryPayload | undefined {
  if (!raw) {
    return undefined;
  }

  const payload: DeliveryPayload = {};
  let hasField = false;

  // files: string[]
  if (Array.isArray(raw.files)) {
    const files = raw.files.filter((v): v is string => typeof v === "string");
    if (files.length > 0) {
      payload.files = files;
      hasField = true;
    }
  }

  // priority: "high" | "medium" | "low"
  const priority = asString(raw.priority);
  if (priority === "high" || priority === "medium" || priority === "low") {
    payload.priority = priority;
    hasField = true;
  }

  // dependencies: string[]
  if (Array.isArray(raw.dependencies)) {
    const deps = raw.dependencies.filter((v): v is string => typeof v === "string");
    if (deps.length > 0) {
      payload.dependencies = deps;
      hasField = true;
    }
  }

  // acceptanceCriteria: string[]
  if (Array.isArray(raw.acceptanceCriteria)) {
    const criteria = raw.acceptanceCriteria.filter((v): v is string => typeof v === "string");
    if (criteria.length > 0) {
      payload.acceptanceCriteria = criteria;
      hasField = true;
    }
  }

  // context: Record<string, unknown>
  const context = asRecord(raw.context);
  if (context && Object.keys(context).length > 0) {
    payload.context = context;
    hasField = true;
  }

  return hasField ? payload : undefined;
}

function normalizeAgentTurn(parsed: unknown, member: TeamMemberDefinition): AgentTurnResponse {
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Parsed response is not an object.");
  }

  const summary = asString(record.summary) ?? `${member.name} completed a turn.`;
  const deliveries = Array.isArray(record.deliveries)
    ? record.deliveries
      .map(asRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .flatMap((delivery) => {
        const to = asString(delivery.to);
        const textValue = asString(delivery.text);
        if (!to || !textValue) {
          return [];
        }

        const kind = asString(delivery.kind);
        const taskIds = Array.isArray(delivery.taskIds)
          ? delivery.taskIds.filter((value): value is string => typeof value === "string")
          : [];
        const payload = normalizePayload(asRecord(delivery.payload));

        return [{
          to,
          text: textValue,
          kind: (kind as TeamDeliveryKind | undefined) ?? undefined,
          taskIds,
          payload,
        }];
      })
    : [];
  const taskUpdates = Array.isArray(record.taskUpdates)
    ? record.taskUpdates
      .map(asRecord)
      .filter((value): value is Record<string, unknown> => Boolean(value))
      .flatMap((update) => {
        const taskId = asString(update.taskId);
        const status = normalizeTaskStatus(asString(update.status));
        if (!taskId || !status) {
          return [];
        }

        return [{
          taskId,
          status,
          assignee: asString(update.assignee),
          note: asString(update.note),
        } satisfies AgentTaskUpdate];
      })
    : [];

  return {
    summary,
    done: member.isOrchestrator ? asBoolean(record.done) ?? false : false,
    deliveries,
    taskUpdates,
  };
}

export function parseAgentTurnJson(json: string, member: TeamMemberDefinition): AgentTurnResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid agent response JSON: ${errorMessage(error)}`);
  }

  return normalizeAgentTurn(parsed, member);
}

function parseAgentTurn(text: string, member: TeamMemberDefinition): AgentTurnResponse {
  return parseAgentTurnJson(extractResponseJson(text), member);
}

export async function readAgentTurnResponse(input: AgentTurnResponseReadInput): Promise<AgentTurnResponse> {
  try {
    const raw = await readFile(input.responseFilePath, "utf8");
    if (!raw.trim()) {
      throw new Error(`Agent response file is empty: ${input.responseFilePath}`);
    }
    return parseAgentTurnJson(raw, input.member);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }

    if (!input.finalText.trim()) {
      throw new Error(`Agent did not write response file: ${input.responseFilePath}`);
    }

    try {
      return parseAgentTurn(input.finalText, input.member);
    } catch (fallbackError) {
      throw new Error(
        `Agent did not write response file ${input.responseFilePath}, and final message fallback could not be parsed: ${errorMessage(fallbackError)}`,
      );
    }
  }
}

function createMessage(input: {
  from: string;
  to: string;
  kind: TeamDeliveryKind;
  text: string;
  taskIds?: string[];
  payload?: DeliveryPayload;
}): TeamMessage {
  return {
    id: crypto.randomUUID(),
    from: input.from,
    to: input.to,
    kind: input.kind,
    text: input.text,
    taskIds: input.taskIds ?? [],
    payload: input.payload,
    createdAt: new Date().toISOString(),
  };
}

export function applyTaskUpdates(tasks: TeamTask[], updates: AgentTaskUpdate[]): boolean {
  let changed = false;

  for (const update of updates) {
    const task = resolveTaskUpdateTarget(tasks, update.taskId);
    if (!task) {
      continue;
    }

    if (task.status !== update.status) {
      task.status = update.status;
      task.checked = update.status === "done";
      changed = true;
    }

    if (update.assignee !== undefined && task.assignee !== update.assignee) {
      task.assignee = update.assignee;
      changed = true;
    }

    if (update.note !== undefined && task.note !== update.note) {
      task.note = update.note;
      changed = true;
    }
  }

  return changed;
}

function resolveTaskUpdateTarget(tasks: TeamTask[], taskId: string): TeamTask | undefined {
  const exact = tasks.find((item) => item.id === taskId);
  if (exact) {
    return exact;
  }

  const ordinalMatch = taskId.match(/^task-(\d+)$/);
  if (!ordinalMatch) {
    return undefined;
  }

  const ordinal = String(Number(ordinalMatch[1])).padStart(2, "0");
  return tasks.find((item) => item.id.startsWith(`task-${ordinal}-`));
}

export async function persistTasks(project: LoadedTeamProject): Promise<void> {
  const lines = project.files.tasks.split(/\r?\n/);
  let changed = false;

  for (const task of project.tasks) {
    const currentLine = lines[task.lineIndex];
    if (!currentLine) {
      continue;
    }

    const nextLine = currentLine.replace(/\[(?: |x|X)\]/, task.checked ? "[x]" : "[ ]");
    if (nextLine !== currentLine) {
      lines[task.lineIndex] = nextLine;
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  project.files.tasks = lines.join("\n");
  await writeFile(project.paths.tasks, project.files.tasks, "utf8");
}

async function loadAgentState(
  member: TeamMemberDefinition,
  project: LoadedTeamProject,
  options: TeamRunOptions,
  states: Map<string, AgentState>,
): Promise<AgentState> {
  const existing = states.get(member.id);
  if (existing) {
    return existing;
  }

  const adapter = getAdapter(member.provider);
  const systemParts = [
    member.isOrchestrator ? options.systemPrompt?.trim() : undefined,
    member.systemPrompt?.trim(),
    buildProtocolPrompt(member, project.team.orchestrator.id),
  ].filter((value): value is string => Boolean(value));

  const config: AdapterSessionConfig = {
    cwd: member.cwd,
    model: member.model,
    systemPrompt: systemParts.join("\n\n"),
    runMode: member.isOrchestrator ? "plan" : options.runMode,
    questionMode: "disabled",
    permissions: {
      mode: options.permissionMode,
      readOnly: member.isOrchestrator,
      allowedReadRoots: member.isOrchestrator ? [member.cwd] : undefined,
    },
  };

  const session = await adapter.createSession(config);
  const state: AgentState = {
    member,
    session,
    bootstrapped: false,
    retryCount: 0,
    transientFailureCount: 0,
  };
  states.set(member.id, state);
  return state;
}

async function runAgentTurn(input: {
  agent: TeamMemberDefinition;
  project: LoadedTeamProject;
  options: TeamRunOptions;
  unread: TeamMessage[];
  recentMessages: TeamMessage[];
  states: Map<string, AgentState>;
  turnNumber: number;
  runId: string;
  outputState: OutputState;
  emit?: TeamRuntimeEventHandler;
  lifecycle: RuntimeLifecycleState;
}): Promise<AgentTurnResponse> {
  const state = await loadAgentState(input.agent, input.project, input.options, input.states);
  const maxRetries = input.project.team.runtime.maxRetries ?? 2;
  let attempt = 0;
  let lastParseError: Error | null = null;

  closeOutputLine(input.outputState);
  if (input.outputState.enabled) {
    stdout.write(`\n=== Turn ${input.turnNumber}: ${input.agent.name} (${input.agent.role}) ===\n`);
  }
  input.emit?.({ type: "turn.started", agentId: input.agent.id, agentName: input.agent.name, role: input.agent.role, turnNumber: input.turnNumber });

  while (attempt <= maxRetries) {
    const responseFilePath = buildTurnResponseFilePath(input.agent, input.runId, input.turnNumber, attempt + 1);
    await mkdir(dirname(responseFilePath), { recursive: true });

    if (attempt === 0) {
      await state.session.send(
        buildTurnPrompt({
          member: input.agent,
          project: input.project,
          unread: input.unread,
          recentMessages: input.recentMessages,
          responseFilePath,
          steeringPrompt: input.options.prompt,
          includeProjectFiles: !state.bootstrapped,
        }),
      );
    } else {
      await state.session.send(buildRepairPrompt(responseFilePath, lastParseError));
    }
    input.emit?.({
      type: "agent.status",
      agentId: input.agent.id,
      category: "session",
      message: "prompt sent; waiting for provider",
    });

    const streamState: AgentStreamState = { textOpen: false, streamedText: "" };
    let finalText = "";
    let turnTimedOut = false;
    const turnTimeoutMs = input.project.team.runtime.maxTurnDurationMs;
    const turnTimeout = turnTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          turnTimedOut = true;
          input.emit?.({
            type: "agent.status",
            agentId: input.agent.id,
            category: "session",
            message: `turn exceeded ${Math.round(turnTimeoutMs / 1000)}s; interrupting provider`,
          });
          void state.session.interrupt().catch(() => {});
        }, turnTimeoutMs);
    turnTimeout?.unref?.();

    try {
      for await (const event of state.session.stream()) {
        if (!input.lifecycle.stopping) {
          handleAgentEvent(input.agent, event, streamState, input.outputState, input.emit);
        }
        if (event.type === "completed") {
          finalText = event.result.text;
        }
      }
    } catch (error) {
      if (turnTimeout) {
        clearTimeout(turnTimeout);
      }
      closeTextLine(input.agent.id, streamState, input.outputState);
      if (input.lifecycle.stopping) {
        throw new Error("__runtime_stopped__");
      }
      if (turnTimedOut && turnTimeoutMs !== undefined) {
        throw new Error(`Agent ${state.member.name} exceeded turn timeout (${Math.round(turnTimeoutMs / 1000)}s).`);
      }
      const errorText = error instanceof Error ? error.message : String(error);
      const modelText = state.member.model ? ` model=${state.member.model}` : "";
      throw new Error(
        `Agent ${state.member.name} failed (provider=${state.member.provider}${modelText}): ${errorText}`,
      );
    } finally {
      if (turnTimeout) {
        clearTimeout(turnTimeout);
      }
    }

    closeTextLine(input.agent.id, streamState, input.outputState);
    state.bootstrapped = true;

    if (input.lifecycle.stopping) {
      throw new Error("__runtime_stopped__");
    }
    if (turnTimedOut && turnTimeoutMs !== undefined) {
      throw new Error(`Agent ${state.member.name} exceeded turn timeout (${Math.round(turnTimeoutMs / 1000)}s).`);
    }

    try {
      const parsed = await readAgentTurnResponse({
        responseFilePath,
        finalText,
        member: input.agent,
      });
      state.retryCount = 0; // reset on success
      writeRuntimeLine(`${input.agent.name} summary: ${parsed.summary}`, input.outputState);
      input.emit?.({ type: "turn.completed", agentId: input.agent.id, summary: parsed.summary, turnNumber: input.turnNumber });
      return parsed;
    } catch (parseError) {
      lastParseError = parseError as Error;
      state.retryCount += 1;
      if (state.retryCount > maxRetries) {
        break; // will throw after loop
      }
      // Log retry and continue
      writeRuntimeLine(`${input.agent.name} parse failed (attempt ${state.retryCount}/${maxRetries}): ${lastParseError.message}`, input.outputState);
      attempt += 1;
    }
  }

  // Exhausted retries
  const retryError = `Agent ${input.agent.name} failed to return valid JSON after ${state.retryCount} attempt(s): ${lastParseError?.message ?? "unknown error"}`;
  input.emit?.({ type: "turn.failed", agentId: input.agent.id, error: retryError, turnNumber: input.turnNumber });
  throw new Error(retryError);
}

function resolveDeliveryTargets(
  deliveryTo: string,
  senderId: string,
  project: LoadedTeamProject,
): string[] {
  const normalized = deliveryTo.trim().toLowerCase();
  if (normalized === "orchestrator") {
    return [project.team.orchestrator.id];
  }

  if (normalized === "group") {
    return [project.team.orchestrator, ...project.team.coworkers]
      .map((member) => member.id)
      .filter((id) => id !== senderId);
  }

  return [normalized];
}

function enqueue(queue: string[], queued: Set<string>, id: string): void {
  if (queued.has(id)) {
    return;
  }
  queue.push(id);
  queued.add(id);
}

function dequeue(queue: string[], queued: Set<string>): string | undefined {
  const next = queue.shift();
  if (next) {
    queued.delete(next);
  }
  return next;
}

function allTasksDone(tasks: TeamTask[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.status === "done");
}

function isTransientProviderFailure(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes("und_err_body_timeout")
    || normalized.includes("event stream timed out")
    || normalized.includes("terminated");
}

async function waitForNextTurn(
  activeTurns: Map<string, Promise<CompletedAgentTurn>>,
): Promise<CompletedAgentTurn> {
  return Promise.race(activeTurns.values());
}

async function interruptRunningTurns(
  running: Set<string>,
  states: Map<string, AgentState>,
): Promise<void> {
  await Promise.all(
    [...running].map(async (agentId) => {
      const state = states.get(agentId);
      if (!state) {
        return;
      }

      try {
        await state.session.interrupt();
      } catch {
        // Best-effort interrupt during shutdown.
      }
    }),
  );
}

export async function loadTeamProject(cwd: string, teamName?: string): Promise<LoadedTeamProject> {
  const projectCwd = resolve(cwd);
  const projectRolesPath = teamName?.trim()
    ? undefined
    : await resolveProjectTeamConfigPath(projectCwd);
  const paths = {
    goal: await resolveExistingProjectContextPath(projectCwd, "goal.md"),
    spec: await resolveExistingProjectContextPath(projectCwd, "spec.md"),
    plan: await resolveExistingProjectContextPath(projectCwd, "plan.md"),
    tasks: await resolveExistingProjectContextPath(projectCwd, "tasks.md"),
    roles: teamName?.trim()
      ? resolveProjectDirectory(projectCwd, "teams", `${teamName.trim()}.json`)
      : projectRolesPath!,
  };
  const teamSourcePromise = teamName?.trim()
    ? loadTeamDefinition(projectCwd, teamName.trim())
    : Promise.resolve({
        name: undefined,
        path: paths.roles,
        content: "",
      });

  const [goal, spec, plan, tasks, rolesSource] = await Promise.all([
    readFile(paths.goal, "utf8"),
    readFile(paths.spec, "utf8"),
    readFile(paths.plan, "utf8"),
    readFile(paths.tasks, "utf8"),
    teamName?.trim()
      ? teamSourcePromise
      : readFile(paths.roles, "utf8").then((content) => ({
          name: undefined,
          path: paths.roles,
          content,
        })),
  ]);
  const files: ProjectContextFiles = {
    goal,
    spec,
    plan,
    tasks,
    roles: rolesSource.content,
  };

  return {
    cwd: projectCwd,
    teamName: rolesSource.name,
    teamSourcePath: rolesSource.path,
    paths: {
      ...paths,
      roles: rolesSource.path,
    },
    files,
    team: parseTeamConfig(files.roles, projectCwd, {
      requireModels: rolesSource.path.endsWith(".json"),
      requireDescriptions: rolesSource.path.endsWith(".json"),
    }),
    tasks: parseTasks(files.tasks),
  };
}

export async function runTeamPrototype(options: TeamRunOptions): Promise<TeamRunResult> {
  registerBuiltinAdapters();
  const emit = options.onEvent;

  const project = await loadTeamProject(options.cwd, options.teamName);
  const runStartedAt = new Date().toISOString();
  const runId = `run-${runStartedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const members = [project.team.orchestrator, ...project.team.coworkers];
  if (options.providerModels) {
    for (const member of members) {
      const override = options.providerModels[member.provider];
      if (override?.trim()) {
        member.model = override.trim();
      }
    }
  }
  if (options.memberModels) {
    for (const member of members) {
      const candidates = [
        member.id,
        member.name,
        normalizeMemberOverrideKey(member.name),
      ];
      const override = candidates
        .map((candidate) => options.memberModels?.[normalizeMemberOverrideKey(candidate)])
        .find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (override) {
        member.model = override.trim();
      }
    }
  }
  if (options.model?.trim()) {
    project.team.orchestrator.model = options.model.trim();
  }
  const memberById = new Map(members.map((member) => [member.id, member]));
  const inboxes = new Map<string, TeamMessage[]>(members.map((member) => [member.id, []]));
  const sharedMessages: TeamMessage[] = [];
  const queue: string[] = [];
  const queued = new Set<string>();
  const states = new Map<string, AgentState>();
  const running = new Set<string>();
  const failedAgents = new Set<string>();
  const transientProviderFailures = new Map<string, number>();
  const activeTurns = new Map<string, Promise<CompletedAgentTurn>>();
  const lifecycle: RuntimeLifecycleState = { stopping: false };
  const outputState: OutputState = {
    enabled: !emit,
    openAgentId: null,
    openStreamState: null,
  };

  const kickoff = createMessage({
    from: "system",
    to: project.team.orchestrator.id,
    kind: "update",
    text: "Review the loaded project context, assign work, and drive the run toward completion.",
  });
  inboxes.get(project.team.orchestrator.id)?.push(kickoff);
  sharedMessages.push(kickoff);

  if (options.prompt?.trim()) {
    const steeringMessage = createMessage({
      from: "user",
      to: project.team.orchestrator.id,
      kind: "update",
      text: options.prompt.trim(),
    });
    inboxes.get(project.team.orchestrator.id)?.push(steeringMessage);
    sharedMessages.push(steeringMessage);
  }

  enqueue(queue, queued, project.team.orchestrator.id);

  if (outputState.enabled) {
    stdout.write("Kyros team mode\n");
    stdout.write(`cwd: ${project.cwd}\n`);
    if (project.teamName) {
      stdout.write(`team: ${project.teamName}\n`);
      stdout.write(`team source: ${project.teamSourcePath}\n`);
    }
    stdout.write(`orchestrator: ${project.team.orchestrator.name} (${project.team.orchestrator.provider})\n`);
    stdout.write(`coworkers: ${project.team.coworkers.map((member) => `${member.name} (${member.role})`).join(", ")}\n`);
    stdout.write(`tasks parsed: ${project.tasks.length}\n`);
  }

  emit?.({
    type: "runtime.started",
    cwd: project.cwd,
    teamName: project.teamName,
    orchestrator: project.team.orchestrator,
    coworkers: project.team.coworkers,
    taskCount: project.tasks.length,
    runtimeConfig: project.team.runtime,
  });
  emit?.({ type: "tasks.updated", tasks: [...project.tasks] });

  let idleTurns = 0;
  let turns = 0;
  let stopReason = "queue exhausted";
  let blockedQuestion: string | undefined;
  let gracefulStopRequested = false;

  try {
    while (true) {
      while (
        !gracefulStopRequested &&
        running.size < project.team.runtime.maxConcurrentAgents
      ) {
        const currentId = dequeue(queue, queued);
        if (!currentId) {
          break;
        }

        if (running.has(currentId)) {
          continue;
        }

        const current = memberById.get(currentId);
        if (!current) {
          continue;
        }

        if (failedAgents.has(currentId)) {
          continue;
        }

        const unread = inboxes.get(currentId) ?? [];
        if (unread.length === 0) {
          continue;
        }

        inboxes.set(currentId, []);
        turns += 1;
        const turnNumber = turns;
        const recentMessages = sharedMessages.slice(-RECENT_MESSAGE_LIMIT);

        running.add(currentId);
        activeTurns.set(
          currentId,
          runAgentTurn({
            agent: current,
            project,
            options,
            unread,
            recentMessages,
            states,
            turnNumber,
            runId,
            outputState,
            emit,
            lifecycle,
          })
            .then((response) => ({
              agent: current,
              response,
              turnNumber,
            }))
            .catch((error) => ({
              agent: current,
              error: error instanceof Error ? error.message : String(error),
              retryMessages: unread,
              turnNumber,
            })),
        );
      }

      if (activeTurns.size === 0) {
        if (gracefulStopRequested) {
          break;
        }

        const pendingTaskIds = project.tasks
          .filter((task) => task.status !== "done")
          .map((task) => task.id);

        if (
          project.team.runtime.stopWhenTasksComplete
          && pendingTaskIds.length === 0
          && !blockedQuestion
          && !failedAgents.has(project.team.orchestrator.id)
        ) {
          const finalReviewMessage = createMessage({
            from: "system",
            to: project.team.orchestrator.id,
            kind: "update",
            text: "All tracked tasks are currently marked done. Review the final state, ask any last questions if needed, and set done=true when you want to stop the run.",
            taskIds: project.tasks.map((task) => task.id),
          });
          inboxes.get(project.team.orchestrator.id)?.push(finalReviewMessage);
          sharedMessages.push(finalReviewMessage);
          enqueue(queue, queued, project.team.orchestrator.id);
          writeRuntimeLine(
            `message ${finalReviewMessage.from} -> ${finalReviewMessage.to} (${finalReviewMessage.kind})`,
            outputState,
          );
          emit?.({ type: "message.routed", message: finalReviewMessage });
          continue;
        }

        if (
          project.team.runtime.stopWhenTasksComplete
          && pendingTaskIds.length > 0
          && !blockedQuestion
          && !failedAgents.has(project.team.orchestrator.id)
        ) {
          const recoveryMessage = createMessage({
            from: "system",
            to: project.team.orchestrator.id,
            kind: "update",
            text: "No active turns remain but unfinished tasks still exist. Review the latest task snapshot, decide what to do next, and continue coordinating the run.",
            taskIds: pendingTaskIds,
          });
          inboxes.get(project.team.orchestrator.id)?.push(recoveryMessage);
          sharedMessages.push(recoveryMessage);
          enqueue(queue, queued, project.team.orchestrator.id);
          writeRuntimeLine(
            `message ${recoveryMessage.from} -> ${recoveryMessage.to} (${recoveryMessage.kind})`,
            outputState,
          );
          emit?.({ type: "message.routed", message: recoveryMessage });
          continue;
        }

        stopReason = "queue exhausted";
        break;
      }

      const completedTurn = await waitForNextTurn(activeTurns);
      activeTurns.delete(completedTurn.agent.id);
      running.delete(completedTurn.agent.id);

      if ("error" in completedTurn) {
        const state = states.get(completedTurn.agent.id);
        const isTransientFailure = isTransientProviderFailure(completedTurn.error);
        const transientFailureCount = (transientProviderFailures.get(completedTurn.agent.id) ?? 0) + 1;

        if (
          isTransientFailure
          && transientFailureCount <= MAX_TRANSIENT_PROVIDER_FAILURES
          && !gracefulStopRequested
          && !lifecycle.stopping
        ) {
          transientProviderFailures.set(completedTurn.agent.id, transientFailureCount);
          if (state) {
            state.transientFailureCount = transientFailureCount;
            await state.session.close().catch(() => {});
            states.delete(completedTurn.agent.id);
          }

          inboxes.set(completedTurn.agent.id, [
            ...completedTurn.retryMessages,
            ...(inboxes.get(completedTurn.agent.id) ?? []),
          ]);
          enqueue(queue, queued, completedTurn.agent.id);
          writeRuntimeLine(
            `${completedTurn.agent.name} transient provider failure (${transientFailureCount}/${MAX_TRANSIENT_PROVIDER_FAILURES}); retrying: ${completedTurn.error}`,
            outputState,
          );
          emit?.({
            type: "agent.status",
            agentId: completedTurn.agent.id,
            category: "retry",
            message: `transient provider failure ${transientFailureCount}/${MAX_TRANSIENT_PROVIDER_FAILURES}: ${completedTurn.error}`,
          });
          continue;
        }

        failedAgents.add(completedTurn.agent.id);
        writeRuntimeLine(
          `${completedTurn.agent.name} failed: ${completedTurn.error}`,
          outputState,
        );
        emit?.({ type: "turn.failed", agentId: completedTurn.agent.id, error: completedTurn.error, turnNumber: completedTurn.turnNumber });

        const failedAssignments = project.tasks.filter((task) =>
          task.assignee === completedTurn.agent.id && task.status !== "done"
        );

        const taskChanged = applyTaskUpdates(
          project.tasks,
          failedAssignments.map((task) => ({
            taskId: task.id,
            status: "blocked",
            assignee: completedTurn.agent.id,
            note: `${completedTurn.agent.name} failed: ${completedTurn.error}`,
          })),
        );
        if (taskChanged) {
          await persistTasks(project);
        }

        const failureMessage = createMessage({
          from: completedTurn.agent.id,
          to: project.team.orchestrator.id,
          kind: "update",
          text: `${completedTurn.agent.name} failed and is unavailable for the rest of this run. Error: ${completedTurn.error}`,
          taskIds: failedAssignments.map((task) => task.id),
        });
        inboxes.get(project.team.orchestrator.id)?.push(failureMessage);
        sharedMessages.push(failureMessage);

        if (completedTurn.agent.id !== project.team.orchestrator.id) {
          idleTurns = 0;
          if (!gracefulStopRequested) {
            enqueue(queue, queued, project.team.orchestrator.id);
          }
          writeRuntimeLine(
            `message ${failureMessage.from} -> ${failureMessage.to} (${failureMessage.kind})`,
            outputState,
          );
          emit?.({ type: "message.routed", message: failureMessage });
          continue;
        }

        stopReason = "orchestrator failed";
        blockedQuestion = completedTurn.error;
        break;
      }

      const response = completedTurn.response;
      transientProviderFailures.delete(completedTurn.agent.id);

      const taskChanged = applyTaskUpdates(project.tasks, response.taskUpdates ?? []);
      if (taskChanged) {
        await persistTasks(project);
        emit?.({ type: "tasks.updated", tasks: [...project.tasks] });
      }

      let deliveredCount = 0;

      for (const delivery of response.deliveries ?? []) {
        const kind = delivery.kind ?? (delivery.to === "group" ? "group" : "update");
        const targets = resolveDeliveryTargets(delivery.to, completedTurn.agent.id, project);

        for (const targetId of targets) {
          if (targetId === "user") {
            const userMessage = createMessage({
              from: completedTurn.agent.id,
              to: "user",
              kind,
              text: delivery.text,
              taskIds: delivery.taskIds,
              payload: delivery.payload,
            });
            sharedMessages.push(userMessage);
            deliveredCount += 1;
            writeRuntimeLine(
              `message ${userMessage.from} -> ${userMessage.to} (${userMessage.kind})`,
              outputState,
            );
            emit?.({ type: "message.routed", message: userMessage });

            if (kind === "question" && !gracefulStopRequested) {
              blockedQuestion = `${completedTurn.agent.name}: ${delivery.text}`;
              stopReason = "blocked on user input";
              break;
            }

            continue;
          }

          const target = memberById.get(targetId);
          if (!target) {
            continue;
          }

          const message = createMessage({
            from: completedTurn.agent.id,
            to: target.id,
            kind,
            text: delivery.text,
            taskIds: delivery.taskIds,
            payload: delivery.payload,
          });

          sharedMessages.push(message);
          if (!gracefulStopRequested) {
            inboxes.get(target.id)?.push(message);
            enqueue(queue, queued, target.id);
          }
          deliveredCount += 1;
          writeRuntimeLine(`message ${message.from} -> ${message.to} (${message.kind})`, outputState);
          emit?.({ type: "message.routed", message });
        }

        if (blockedQuestion) {
          break;
          }
        }

      if (blockedQuestion) {
        lifecycle.stopping = true;
        await interruptRunningTurns(running, states);
        break;
      }

      if (response.done && completedTurn.agent.id === project.team.orchestrator.id) {
        gracefulStopRequested = true;
        stopReason = "orchestrator finished";
        queue.length = 0;
        queued.clear();
        idleTurns = 0;
        writeRuntimeLine(
          "orchestrator requested graceful stop; waiting for active turns to finish",
          outputState,
        );
        if (activeTurns.size === 0) {
          break;
        }
        continue;
      }

      if (
        !gracefulStopRequested &&
        (inboxes.get(completedTurn.agent.id) ?? []).length > 0
      ) {
        enqueue(queue, queued, completedTurn.agent.id);
      }

      if (taskChanged || deliveredCount > 0) {
        idleTurns = 0;
      } else {
        idleTurns += 1;
        writeRuntimeLine(`idle completion ${idleTurns}/${project.team.runtime.maxIdleTurns}`, outputState);
        emit?.({ type: "idle.tick", count: idleTurns, max: project.team.runtime.maxIdleTurns });
        if (
          idleTurns >= project.team.runtime.maxIdleTurns &&
          activeTurns.size === 0 &&
          queue.length === 0
        ) {
          lifecycle.stopping = true;
          await interruptRunningTurns(running, states);
          stopReason = "max idle turns reached";
          break;
        }
      }
    }

    closeOutputLine(outputState);
    if (outputState.enabled) {
      stdout.write("\n");
    }
    writeRuntimeLine(`stop: ${stopReason}`, outputState);
    writeRuntimeLine(`turns: ${turns}`, outputState);
    writeRuntimeLine(`task snapshot:\n${formatTaskSnapshot(project.tasks)}`, outputState);

    if (blockedQuestion) {
      writeRuntimeLine(`user input needed: ${blockedQuestion}`, outputState);
    }
  } finally {
    lifecycle.stopping = true;
    await interruptRunningTurns(running, states);
    await Promise.allSettled([...activeTurns.values()]);
    closeOutputLine(outputState);
    // Persist run history to .kyros/runs/run-<timestamp>.json
    try {
      const runsDir = resolve(project.cwd, ".kyros", "runs");
      await mkdir(runsDir, { recursive: true });
      const record: TeamRunRecord = {
        id: runId,
        createdAt: runStartedAt,
        stopReason,
        turns,
        blockedQuestion,
        finalTasks: project.tasks.map((task): TeamTaskRecord => ({
          id: task.id,
          title: task.title,
          checked: task.checked,
          status: task.status,
          assignee: task.assignee,
          note: task.note,
          lineIndex: task.lineIndex,
        })),
        messages: sharedMessages.map((msg): TeamMessageRecord => ({
          id: msg.id,
          from: msg.from,
          to: msg.to,
          kind: msg.kind,
          text: msg.text,
          taskIds: msg.taskIds,
          payload: msg.payload,
          createdAt: msg.createdAt,
        })),
      };
      const filePath = resolve(runsDir, `${runId}.json`);
      await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
    } catch (persistErr) {
      // Best-effort persistence - log but don't fail the run.
      writeRuntimeLine(`failed to persist run history: ${persistErr instanceof Error ? persistErr.message : persistErr}`, outputState);
    }
    await Promise.all(
      [...states.values()].map(async (state) => {
        try {
          await state.session.close();
        } catch {
          // Best-effort session cleanup.
        }
      }),
    );
  }

  emit?.({ type: "runtime.stopped", reason: stopReason, turns, tasks: [...project.tasks], blockedQuestion });

  return {
    stopReason,
    turns,
    blockedQuestion,
  };
}
