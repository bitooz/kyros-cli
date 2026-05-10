import {
  query,
  type Options,
  type SDKAssistantMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AdapterEvent, AdapterFactory, AdapterModelOption, AdapterRunResult, AdapterSession, AdapterSessionConfig, PermissionDecision, PermissionRequest, QuestionAnswer, QuestionRequest, TokenUsage } from "./types.js";
import { mergeSystemPrompt } from "./prompting.js";

const CLAUDE_DEFAULT_MODEL_OPTION: AdapterModelOption = {
  label: "Default",
  description: "Use Claude Code's recommended default model.",
};

const CLAUDE_FALLBACK_MODEL_OPTIONS: AdapterModelOption[] = [
  {
    value: "sonnet",
    label: "Sonnet",
    description: "Latest Sonnet alias for daily coding tasks.",
  },
  {
    value: "opus",
    label: "Opus",
    description: "Latest Opus alias for heavier reasoning and planning.",
  },
  {
    value: "haiku",
    label: "Haiku",
    description: "Fast Claude alias for lighter tasks.",
  },
  {
    value: "sonnet[1m]",
    label: "Sonnet 1M",
    description: "Sonnet with a 1 million token context window when available.",
  },
  {
    value: "opus[1m]",
    label: "Opus 1M",
    description: "Opus with a 1 million token context window when available.",
  },
  {
    value: "opusplan",
    label: "Opus Plan",
    description: "Use Opus in plan mode and Sonnet in execution mode.",
  },
];

function dedupeModelOptions(options: AdapterModelOption[]): AdapterModelOption[] {
  const seen = new Set<string>();
  const deduped: AdapterModelOption[] = [];

  for (const option of options) {
    const key = option.value ?? `label:${option.label}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(option);
  }

  return deduped;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function defaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function appendOnlyDelta(existing: string, incoming: string): string {
  if (!incoming) return "";
  if (!existing) return incoming;
  if (incoming === existing) return "";
  if (incoming.startsWith(existing)) return incoming.slice(existing.length);

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return incoming.slice(overlap);
    }
  }

  return incoming;
}

function extractClaudeAssistantText(message: SDKAssistantMessage): string {
  const record = asRecord(message.message);
  const content = record?.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((item) => {
      const block = asRecord(item);
      const text = asString(block?.text);
      return text ? [text] : [];
    })
    .join("");
}

function extractClaudeTextDelta(message: SDKMessage): string {
  if (message.type !== "stream_event") {
    return "";
  }

  const event = asRecord(message.event);
  const eventType = asString(event?.type);

  if (eventType === "content_block_start") {
    const block = asRecord(event?.content_block);
    return asString(block?.text) ?? "";
  }

  if (eventType === "content_block_delta") {
    const delta = asRecord(event?.delta);
    return asString(delta?.text) ?? "";
  }

  return "";
}

function getClaudeEventType(message: SDKMessage): string {
  if (message.type === "system") {
    return `system.${message.subtype}`;
  }

  if (message.type === "stream_event") {
    const event = asRecord(message.event);
    const eventType = asString(event?.type);
    return eventType ? `stream_event.${eventType}` : "stream_event";
  }

  if (message.type === "result") {
    return `result.${message.subtype}`;
  }

  return message.type;
}

function getClaudeStatusEvents(message: SDKMessage): AdapterEvent[] {
  if (message.type === "system") {
    switch (message.subtype) {
      case "init":
        return [{
          type: "status",
          category: "session",
          message: `initialized model=${message.model} permission=${message.permissionMode}`,
          data: {
            cwd: message.cwd,
            tools: message.tools,
            agents: message.agents ?? [],
            mcpServers: message.mcp_servers,
            skills: message.skills,
            plugins: message.plugins,
          },
        }];
      case "status":
        return [{
          type: "status",
          category: "session",
          message: message.status
            ? `status ${message.status}`
            : `permission mode ${message.permissionMode ?? "unknown"}`,
          data: message,
        }];
      case "session_state_changed":
        return [{
          type: "status",
          category: "session",
          message: `state ${message.state}`,
          data: message,
        }];
      case "task_started":
        return [{
          type: "status",
          category: "task",
          message: `started ${message.description}`,
          data: {
            taskId: message.task_id,
            taskType: message.task_type,
            workflowName: message.workflow_name,
            toolUseId: message.tool_use_id,
            prompt: message.prompt,
          },
        }];
      case "task_progress":
        return [{
          type: "status",
          category: "task",
          message: message.summary ?? message.description,
          data: {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            lastToolName: message.last_tool_name,
            usage: message.usage,
          },
        }];
      case "task_notification":
        return [{
          type: "status",
          category: "task",
          message: `${message.status} ${message.summary}`,
          data: {
            taskId: message.task_id,
            toolUseId: message.tool_use_id,
            outputFile: message.output_file,
            usage: message.usage,
          },
        }];
      case "hook_started":
        return [{
          type: "status",
          category: "hook",
          message: `started ${message.hook_name}`,
          data: message,
        }];
      case "hook_progress":
        return [{
          type: "status",
          category: "hook",
          message: `progress ${message.hook_name}`,
          data: message,
        }];
      case "hook_response":
        return [{
          type: "status",
          category: "hook",
          message: `${message.outcome} ${message.hook_name}`,
          data: message,
        }];
      case "api_retry":
        return [{
          type: "status",
          category: "retry",
          message: `attempt ${message.attempt}/${message.max_retries} in ${message.retry_delay_ms}ms`,
          data: message,
        }];
      case "compact_boundary":
        return [{
          type: "status",
          category: "compaction",
          message: `compact boundary (${message.compact_metadata.trigger})`,
          data: message.compact_metadata,
        }];
      case "files_persisted":
        return [{
          type: "status",
          category: "files",
          message: `persisted ${message.files.length} file(s)`,
          data: {
            files: message.files,
            failed: message.failed,
          },
        }];
      case "local_command_output":
        return [{
          type: "status",
          category: "command",
          message: "local command output",
          data: message.content,
        }];
      case "elicitation_complete":
        return [{
          type: "status",
          category: "elicitation",
          message: `completed ${message.mcp_server_name}`,
          data: {
            elicitationId: message.elicitation_id,
          },
        }];
      default:
        return [];
    }
  }

  switch (message.type) {
    case "tool_progress":
      return [{
        type: "status",
        category: "tool",
        message: `${message.tool_name} running`,
        data: {
          toolUseId: message.tool_use_id,
          parentToolUseId: message.parent_tool_use_id,
          taskId: message.task_id,
          elapsedSeconds: message.elapsed_time_seconds,
        },
      }];
    case "tool_use_summary":
      return [{
        type: "status",
        category: "tool",
        message: message.summary,
        data: {
          precedingToolUseIds: message.preceding_tool_use_ids,
        },
      }];
    case "auth_status":
      return [{
        type: "status",
        category: "auth",
        message: message.isAuthenticating ? "authenticating" : "authentication idle",
        data: {
          output: message.output,
          error: message.error,
        },
      }];
    case "rate_limit_event":
      return [{
        type: "status",
        category: "rate-limit",
        message: message.rate_limit_info.status,
        data: message.rate_limit_info,
      }];
    case "prompt_suggestion":
      return [{
        type: "status",
        category: "prompt",
        message: message.suggestion,
      }];
    default:
      return [];
  }
}

function toQuestionRequest(input: Record<string, unknown>): QuestionRequest {
  const questions = Array.isArray(input.questions) ? input.questions : [];

  return {
    questions: questions.flatMap((entry) => {
      const question = asRecord(entry);
      const text = asString(question?.question);
      const header = asString(question?.header);
      const options = Array.isArray(question?.options) ? question.options : [];

      if (!text || !header) {
        return [];
      }

      return [{
        id: text,
        question: text,
        header,
        multiSelect: question?.multiSelect === true,
        allowCustom: true,
        options: options.flatMap((option) => {
          const item = asRecord(option);
          const label = asString(item?.label);
          const description = asString(item?.description);
          if (!label || !description) {
            return [];
          }
          return [{
            label,
            description,
            preview: asString(item?.preview),
          }];
        }),
      }];
    }),
  };
}

function toClaudeQuestionInput(
  request: QuestionRequest,
  answer: QuestionAnswer,
): Record<string, unknown> {
  const answers = Object.fromEntries(
    request.questions.map((question) => {
      const value = answer.answers[question.id];
      return [
        question.question,
        Array.isArray(value) ? value.join(", ") : (value ?? ""),
      ];
    }),
  );

  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect ?? false,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
        ...(option.preview ? { preview: option.preview } : {}),
      })),
    })),
    answers,
  };
}

function resolveClaudePermissionMode(
  config: AdapterSessionConfig,
): Pick<Options, "permissionMode" | "allowDangerouslySkipPermissions"> {
  if (config.runMode === "plan") {
    return { permissionMode: "plan" };
  }

  switch (config.permissions?.mode) {
    case "bypass":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };
    case "interactive":
      return { permissionMode: "default" };
    case "auto":
    default:
      return { permissionMode: "acceptEdits" };
  }
}

function buildClaudeSandbox(config: AdapterSessionConfig): Options["sandbox"] {
  const permissions = config.permissions;

  if (!permissions || permissions.disableSandbox === true) {
    return undefined;
  }

  const hasFs =
    Boolean(permissions.allowedWritePaths?.length) ||
    Boolean(permissions.allowedReadRoots?.length) ||
    Boolean(permissions.deniedReadPaths?.length);
  const hasNetwork =
    Boolean(permissions.allowedDomains?.length) ||
    permissions.allowLocalNetwork === true;

  if (permissions.readOnly === true) {
    return {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowRead: permissions.allowedReadRoots?.length
          ? permissions.allowedReadRoots
          : [config.cwd],
        ...(permissions.deniedReadPaths?.length
          ? { denyRead: permissions.deniedReadPaths }
          : {}),
      },
      ...(hasNetwork
        ? {
            network: {
              ...(permissions.allowedDomains?.length
                ? { allowedDomains: permissions.allowedDomains }
                : {}),
              ...(permissions.allowLocalNetwork != null
                ? { allowLocalBinding: permissions.allowLocalNetwork }
                : {}),
            },
          }
        : {}),
    };
  }

  if (!hasFs && !hasNetwork) {
    return { enabled: true };
  }

  return {
    enabled: true,
    autoAllowBashIfSandboxed: config.permissions?.mode === "auto",
    ...(hasFs
      ? {
          filesystem: {
            ...(permissions.allowedWritePaths?.length
              ? { allowWrite: permissions.allowedWritePaths }
              : {}),
            ...(permissions.allowedReadRoots?.length
              ? { allowRead: permissions.allowedReadRoots }
              : {}),
            ...(permissions.deniedReadPaths?.length
              ? { denyRead: permissions.deniedReadPaths }
              : {}),
          },
        }
      : {}),
    ...(hasNetwork
      ? {
          network: {
            ...(permissions.allowedDomains?.length
              ? { allowedDomains: permissions.allowedDomains }
              : {}),
            ...(permissions.allowLocalNetwork != null
              ? { allowLocalBinding: permissions.allowLocalNetwork }
              : {}),
          },
        }
      : {}),
  };
}

async function resolvePermissionDecision(
  config: AdapterSessionConfig,
  request: PermissionRequest,
): Promise<PermissionDecision> {
  if (config.permissions?.readOnly === true) {
    return {
      behavior: "deny",
      message: "This session is read-only.",
    };
  }

  if (config.onPermissionRequest) {
    return config.onPermissionRequest(request);
  }

  if (config.permissions?.mode === "auto" || config.permissions?.mode === "bypass") {
    return { behavior: "allow", updatedInput: request.input };
  }

  return {
    behavior: "deny",
    message: "No permission handler configured for Claude adapter session.",
  };
}

class ClaudeAdapterSession implements AdapterSession {
  readonly provider = "claudeCode" as const;

  private readonly pendingPrompts: string[] = [];
  private sessionId: string | undefined;
  private closed = false;
  private currentQuery: ReturnType<typeof query> | null = null;

  constructor(private readonly config: AdapterSessionConfig) {}

  get id(): string | undefined {
    return this.sessionId;
  }

  async send(prompt: string): Promise<void> {
    if (this.closed) {
      throw new Error("Claude adapter session is closed.");
    }
    this.pendingPrompts.push(prompt);
  }

  async *stream(): AsyncGenerator<AdapterEvent, void, undefined> {
    const prompt = this.pendingPrompts.shift();
    if (!prompt || this.closed) {
      return;
    }

    const pendingEvents: AdapterEvent[] = [];
    const mergedSystemPrompt = mergeSystemPrompt({
      systemPrompt: this.config.systemPrompt,
      runMode: this.config.runMode,
      questionMode: this.config.questionMode,
    });

    const options: Options = {
      cwd: this.config.cwd,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(mergedSystemPrompt ? { systemPrompt: mergedSystemPrompt } : {}),
      includePartialMessages: true,
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: async (toolName, input, context) => {
        if (toolName === "AskUserQuestion") {
          const request = toQuestionRequest(input);
          pendingEvents.push({ type: "question", request });

          const answer = await this.config.onQuestion?.(request);
          if (!answer) {
            return {
              behavior: "deny",
              message: "No question handler configured for Claude adapter session.",
              toolUseID: context.toolUseID,
            };
          }

          return {
            behavior: "allow",
            updatedInput: toClaudeQuestionInput(request, answer),
            toolUseID: context.toolUseID,
          };
        }

        const request: PermissionRequest = {
          id: context.toolUseID,
          tool: toolName,
          input,
          description: context.description ?? context.title ?? context.decisionReason,
          path: context.blockedPath,
        };

        pendingEvents.push({ type: "permission.request", request });
        const decision = await resolvePermissionDecision(this.config, request);
        return decision.behavior === "allow"
          ? {
              behavior: "allow",
              updatedInput: decision.updatedInput ?? input,
              toolUseID: context.toolUseID,
            }
          : {
              behavior: "deny",
              message: decision.message ?? "Permission denied.",
              toolUseID: context.toolUseID,
            };
      },
      ...resolveClaudePermissionMode(this.config),
      ...(buildClaudeSandbox(this.config)
        ? { sandbox: buildClaudeSandbox(this.config) }
        : {}),
    };

    let accumulatedText = "";
    let usage = defaultUsage();

    try {
      this.currentQuery = query({
        prompt,
        options: this.sessionId ? { ...options, resume: this.sessionId } : { ...options, sessionId: crypto.randomUUID() },
      });

      for await (const message of this.currentQuery) {
        if ("session_id" in message && typeof message.session_id === "string") {
          const previous = this.sessionId;
          this.sessionId = message.session_id;
          if (!previous) {
            yield {
              type: "session.started",
              provider: this.provider,
              sessionId: this.sessionId,
              model: this.config.model,
            };
          }
        }

        while (pendingEvents.length > 0) {
          yield pendingEvents.shift()!;
        }

        yield {
          type: "provider.event",
          provider: this.provider,
          eventType: getClaudeEventType(message),
          data: message,
        };

        for (const event of getClaudeStatusEvents(message)) {
          yield event;
        }

        const textDelta = extractClaudeTextDelta(message);
        if (textDelta) {
          accumulatedText += textDelta;
          yield { type: "text.delta", text: textDelta };
          continue;
        }

        if (message.type === "assistant") {
          const fullText = extractClaudeAssistantText(message);
          const delta = appendOnlyDelta(accumulatedText, fullText);
          accumulatedText = fullText || accumulatedText;
          if (delta) {
            yield { type: "text.delta", text: delta };
          }
          if (fullText) {
            yield { type: "message.completed", text: fullText };
          }
          continue;
        }

        if (message.type === "system" && message.subtype === "files_persisted") {
          for (const file of message.files) {
            yield {
              type: "file.change",
              path: file.filename,
              kind: "update",
            };
          }
          continue;
        }

        if (message.type === "tool_progress") {
          yield {
            type: "tool.use",
            tool: message.tool_name,
            input: {
              toolUseId: message.tool_use_id,
              taskId: message.task_id,
            },
          };
          continue;
        }

        if (message.type === "system" && message.subtype === "task_progress") {
          yield { type: "thinking", text: message.summary ?? message.description };
          continue;
        }

        if (message.type === "system" && message.subtype === "local_command_output") {
          yield {
            type: "command",
            command: "claude-local-command",
            output: message.content,
            exitCode: 0,
          };
          continue;
        }

        if (message.type === "result") {
          usage = {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            costUsd: message.total_cost_usd,
          };

          const resultText =
            message.subtype === "success" && message.result
              ? message.result
              : accumulatedText;

          yield {
            type: "completed",
            result: {
              provider: this.provider,
              sessionId: this.sessionId,
              text: resultText,
              usage,
              raw: message,
            },
          };
          continue;
        }
      }
    } finally {
      this.currentQuery = null;
    }
  }

  async interrupt(): Promise<void> {
    this.currentQuery?.close();
    this.currentQuery = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.currentQuery?.close();
    this.currentQuery = null;
  }
}

export class ClaudeAdapter implements AdapterFactory {
  async createSession(config: AdapterSessionConfig): Promise<AdapterSession> {
    return new ClaudeAdapterSession(config);
  }

  async listModels(input: { cwd: string }): Promise<AdapterModelOption[]> {
    let activeQuery: ReturnType<typeof query> | undefined;

    try {
      activeQuery = query({
        prompt: "Return the available Claude models for this session.",
        options: {
          cwd: input.cwd,
          permissionMode: "plan",
          maxTurns: 1,
          persistSession: false,
        },
      });

      const discoveredModels = await activeQuery.supportedModels();
      const discoveredDefaultModel = discoveredModels.find((model) => model.value === "default");
      const defaultOption: AdapterModelOption = discoveredDefaultModel
        ? {
            label: discoveredDefaultModel.displayName || CLAUDE_DEFAULT_MODEL_OPTION.label,
            description: discoveredDefaultModel.description || CLAUDE_DEFAULT_MODEL_OPTION.description,
          }
        : CLAUDE_DEFAULT_MODEL_OPTION;
      const discoveredOptions = discoveredModels
        .filter((model) => model.value !== "default")
        .map((model) => ({
          value: model.value,
          label: model.displayName || model.value,
          description: model.description || `Use ${model.displayName || model.value}.`,
        }));

      return dedupeModelOptions([
        defaultOption,
        ...(discoveredOptions.length > 0
          ? discoveredOptions
          : CLAUDE_FALLBACK_MODEL_OPTIONS),
      ]);
    } catch {
      return [CLAUDE_DEFAULT_MODEL_OPTION, ...CLAUDE_FALLBACK_MODEL_OPTIONS];
    } finally {
      if (activeQuery) {
        try {
          await activeQuery.interrupt();
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  }
}
