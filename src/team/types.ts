import type {
  AdapterPermissionMode,
  AdapterProvider,
  AdapterQuestionMode,
  AdapterRunMode,
} from "../adapters/index.js";

export type TeamTaskStatus = "todo" | "in_progress" | "done" | "blocked";
export type TeamDeliveryKind = "task" | "update" | "question" | "answer" | "group";

export interface TeamMemberDefinition {
  id: string;
  name: string;
  role: string;
  description?: string;
  provider: AdapterProvider;
  model?: string;
  systemPrompt?: string;
  cwd: string;
  isOrchestrator: boolean;
}

export interface TeamRuntimeDefinition {
  maxTurns: number;
  maxIdleTurns: number;
  stopWhenTasksComplete: boolean;
  maxConcurrentAgents: number;
  maxRetries?: number; // For invalid JSON responses, default 2
  maxTurnDurationMs?: number;
}

export interface TeamDefinition {
  orchestrator: TeamMemberDefinition;
  coworkers: TeamMemberDefinition[];
  runtime: TeamRuntimeDefinition;
}

export interface ProjectContextFiles {
  goal: string;
  spec: string;
  plan: string;
  tasks: string;
  roles: string;
}

export interface TeamTask {
  id: string;
  title: string;
  checked: boolean;
  status: TeamTaskStatus;
  assignee?: string;
  note?: string;
  lineIndex: number;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  kind: TeamDeliveryKind;
  text: string;
  taskIds: string[];
  /** Optional structured payload attached to the message. */
  payload?: DeliveryPayload;
  createdAt: string;
}

export interface AgentDelivery {
  to: string;
  kind?: TeamDeliveryKind;
  text: string;
  taskIds?: string[];
  /** Optional structured payload for richer assignments (e.g., file paths, diffs, specs). */
  payload?: DeliveryPayload;
}

/**
 * Structured payload that agents can attach to deliveries for richer assignments.
 * All fields are optional — agents include only what is relevant.
 */
export interface DeliveryPayload {
  /** File paths relevant to the assignment or update. */
  files?: string[];
  /** Priority hint: "high" | "medium" | "low". */
  priority?: "high" | "medium" | "low";
  /** Task IDs this delivery depends on or is blocked by. */
  dependencies?: string[];
  /** Acceptance criteria the recipient should verify before marking work done. */
  acceptanceCriteria?: string[];
  /** Free-form context object for domain-specific data (diffs, specs, config, etc.). */
  context?: Record<string, unknown>;
}

export interface AgentTaskUpdate {
  taskId: string;
  status: TeamTaskStatus;
  assignee?: string;
  note?: string;
}

export interface AgentTurnResponse {
  summary: string;
  done?: boolean;
  deliveries?: AgentDelivery[];
  taskUpdates?: AgentTaskUpdate[];
}

export interface LoadedTeamProject {
  cwd: string;
  teamName?: string;
  teamSourcePath: string;
  paths: Record<keyof ProjectContextFiles, string>;
  files: ProjectContextFiles;
  team: TeamDefinition;
  tasks: TeamTask[];
}

export interface TeamRunOptions {
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
  onEvent?: TeamRuntimeEventHandler;
}

export interface TeamRunResult {
  stopReason: string;
  turns: number;
  blockedQuestion?: string;
}

/** Persistence records for runs and messages. */
export interface TeamMessageRecord {
  id: string;
  from: string;
  to: string;
  kind: TeamDeliveryKind;
  text: string;
  taskIds: string[];
  payload?: DeliveryPayload;
  createdAt: string;
}

export interface TeamTaskRecord {
  id: string;
  title: string;
  checked: boolean;
  status: TeamTaskStatus;
  assignee?: string;
  note?: string;
  lineIndex: number;
}

export interface TeamRunRecord {
  id: string;
  createdAt: string;
  stopReason: string;
  turns: number;
  blockedQuestion?: string;
  finalTasks: TeamTaskRecord[];
  messages: TeamMessageRecord[];
}

// ── Runtime events for the Ink UI ──────────────────────────────────────

export type TeamRuntimeEvent =
  | { type: "runtime.started"; cwd: string; teamName?: string; orchestrator: TeamMemberDefinition; coworkers: TeamMemberDefinition[]; taskCount: number; runtimeConfig: TeamRuntimeDefinition }
  | { type: "turn.started"; agentId: string; agentName: string; role: string; turnNumber: number }
  | { type: "agent.text.delta"; agentId: string; text: string }
  | { type: "agent.status"; agentId: string; category: string; message: string }
  | { type: "agent.thinking"; agentId: string; text: string }
  | { type: "agent.tool.use"; agentId: string; tool: string; input: unknown }
  | { type: "agent.tool.result"; agentId: string; tool: string; output: unknown }
  | { type: "agent.command"; agentId: string; command: string; exitCode: number; output?: string }
  | { type: "agent.file.change"; agentId: string; kind: string; path: string }
  | { type: "agent.permission"; agentId: string; tool: string }
  | { type: "agent.error"; agentId: string; message: string }
  | { type: "agent.session.started"; agentId: string; provider: string; model?: string }
  | { type: "turn.completed"; agentId: string; summary: string; turnNumber: number }
  | { type: "turn.failed"; agentId: string; error: string; turnNumber: number }
  | { type: "message.routed"; message: TeamMessage }
  | { type: "tasks.updated"; tasks: TeamTask[] }
  | { type: "idle.tick"; count: number; max: number }
  | { type: "runtime.stopped"; reason: string; turns: number; tasks: TeamTask[]; blockedQuestion?: string }

export type TeamRuntimeEventHandler = (event: TeamRuntimeEvent) => void;
