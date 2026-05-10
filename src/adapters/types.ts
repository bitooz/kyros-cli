export type AdapterProvider = "claudeCode" | "codex" | "opencode";
export type AdapterRunMode = "execute" | "plan";
export type AdapterQuestionMode = "auto" | "required" | "disabled";
export type AdapterPermissionMode = "auto" | "interactive" | "bypass";

export interface PermissionRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
  path?: string;
}

export interface PermissionDecision {
  behavior: "allow" | "deny";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
}

export interface QuestionRequest {
  questions: QuestionPrompt[];
}

export interface QuestionAnswer {
  answers: Record<string, string | string[]>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface AdapterPermissionConfig {
  mode?: AdapterPermissionMode;
  readOnly?: boolean;
  allowedTools?: string[];
  allowedWritePaths?: string[];
  allowedReadRoots?: string[];
  deniedReadPaths?: string[];
  allowedDomains?: string[];
  allowLocalNetwork?: boolean;
  disableSandbox?: boolean;
}

export interface AdapterSessionConfig {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  runMode?: AdapterRunMode;
  questionMode?: AdapterQuestionMode;
  permissions?: AdapterPermissionConfig;
  onPermissionRequest?: (
    request: PermissionRequest,
  ) => Promise<PermissionDecision>;
  onQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer | undefined>;
}

export interface AdapterRunResult {
  provider: AdapterProvider;
  sessionId?: string;
  text: string;
  usage: TokenUsage;
  raw?: unknown;
}

export interface AdapterModelOption {
  value?: string;
  label: string;
  description: string;
  group?: string;
}

export type AdapterEvent =
  | {
      type: "session.started";
      provider: AdapterProvider;
      sessionId?: string;
      model?: string;
    }
  | {
      type: "status";
      category: string;
      message: string;
      data?: unknown;
    }
  | {
      type: "provider.event";
      provider: AdapterProvider;
      eventType: string;
      data: unknown;
    }
  | { type: "text.delta"; text: string }
  | { type: "message.completed"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool.use"; tool: string; input: unknown }
  | { type: "tool.result"; tool: string; output: unknown }
  | { type: "command"; command: string; output: string; exitCode: number }
  | { type: "file.change"; path: string; kind: "add" | "update" | "delete" }
  | { type: "permission.request"; request: PermissionRequest }
  | { type: "question"; request: QuestionRequest }
  | { type: "error"; error: string }
  | { type: "completed"; result: AdapterRunResult };

export interface AdapterSession {
  readonly provider: AdapterProvider;
  readonly id?: string;
  send(prompt: string): Promise<void>;
  stream(): AsyncGenerator<AdapterEvent, void, undefined>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AdapterFactory {
  createSession(config: AdapterSessionConfig): Promise<AdapterSession>;
  listModels?(input: { cwd: string }): Promise<AdapterModelOption[]>;
}
