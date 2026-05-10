import {
  createOpencodeClient,
  createOpencodeServer,
  type Event as OpenCodeEvent,
  type Message,
  type Part,
  type PermissionRequest as OpenCodePermissionRequest,
  type QuestionRequest as OpenCodeQuestionRequest,
  type QuestionAnswer as OpenCodeQuestionAnswer,
  type SessionStatus as OpenCodeSessionStatus,
} from "@opencode-ai/sdk/v2";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { Agent } from "undici";
import type { AdapterEvent, AdapterFactory, AdapterModelOption, AdapterSession, AdapterSessionConfig, PermissionDecision, PermissionRequest, QuestionAnswer, QuestionRequest, TokenUsage } from "./types.js";
import { mergeSystemPrompt } from "./prompting.js";

interface OpenCodeHandle {
  client: ReturnType<typeof createOpencodeClient>;
  server: Awaited<ReturnType<typeof createOpencodeServer>>;
  dispatcher: Agent;
}
const execFileAsync = promisify(execFile);
const DEFAULT_OPENCODE_WAIT_HEARTBEAT_MS = 15_000;
let openCodeModelCache:
  | {
      cwd: string;
      timestamp: number;
      options: AdapterModelOption[];
    }
  | null = null;

let openCodeHandlePromise: Promise<OpenCodeHandle> | null = null;
let openCodeActiveSessions = 0;

function defaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
}

function delay(ms: number): Promise<"heartbeat"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("heartbeat"), ms);
    timer.unref?.();
  });
}

function getOpenCodeWaitHeartbeatMs(): number {
  const raw = process.env.KYROS_INK_OPENCODE_WAIT_HEARTBEAT_MS?.trim();
  if (!raw) {
    return DEFAULT_OPENCODE_WAIT_HEARTBEAT_MS;
  }

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_OPENCODE_WAIT_HEARTBEAT_MS;
}

function getConfiguredOpenCodePort(): number | undefined {
  const raw = process.env.KYROS_INK_OPENCODE_PORT?.trim();
  if (!raw) {
    return undefined;
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return undefined;
  }

  return port;
}

function getConfiguredOpenCodeStartupTimeout(): number {
  const raw = process.env.KYROS_INK_OPENCODE_STARTUP_TIMEOUT_MS?.trim();
  if (!raw) {
    return 30_000;
  }

  const timeout = Number(raw);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return 30_000;
  }

  return timeout;
}

async function findAvailableOpenCodePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();

    probe.once("error", (error) => {
      reject(error);
    });

    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => {
          reject(new Error("Failed to resolve an available OpenCode port."));
        });
        return;
      }

      const { port } = address;
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createOpenCodeHandle(): Promise<OpenCodeHandle> {
  const configuredPort = getConfiguredOpenCodePort();
  const port = configuredPort ?? await findAvailableOpenCodePort();
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: getConfiguredOpenCodeStartupTimeout(),
  });
  const dispatcher = new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
  });
  // OpenCode's generated SSE client uses fetch for a long-lived local event
  // stream. Node ignores the SDK's Request.timeout=false shim, so explicitly
  // disable undici body timeouts for this client.
  const fetchWithoutBodyTimeout: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      dispatcher,
    } as unknown as RequestInit);
  const client = createOpencodeClient({
    baseUrl: server.url,
    fetch: fetchWithoutBodyTimeout,
  });

  return {
    client,
    server,
    dispatcher,
  };
}

async function getOpenCodeHandle(): Promise<OpenCodeHandle> {
  if (!openCodeHandlePromise) {
    openCodeHandlePromise = createOpenCodeHandle();
  }
  try {
    return await openCodeHandlePromise;
  } catch (error) {
    openCodeHandlePromise = null;
    throw error;
  }
}

async function closeOpenCodeHandleIfIdle(): Promise<void> {
  if (openCodeActiveSessions > 0 || !openCodeHandlePromise) {
    return;
  }

  const handlePromise = openCodeHandlePromise;
  openCodeHandlePromise = null;

  try {
    const handle = await handlePromise;
    handle.server.close();
    await handle.dispatcher.close();
  } catch {
    // If startup failed, getOpenCodeHandle already cleared the singleton.
  }
}

async function releaseOpenCodeSession(): Promise<void> {
  openCodeActiveSessions = Math.max(0, openCodeActiveSessions - 1);
  await closeOpenCodeHandleIfIdle();
}

async function listOpenCodeCliModels(providerId: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "opencode",
    ["models", providerId],
    {
      env: process.env,
      timeout: 8_000,
      maxBuffer: 1024 * 1024,
    },
  );

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function toOpenCodeModel(model: string | undefined):
  | { providerID: string; modelID: string }
  | undefined {
  if (!model) {
    return undefined;
  }

  const [providerID, ...rest] = model.split("/");
  if (!providerID || rest.length === 0) {
    return undefined;
  }

  return {
    providerID,
    modelID: rest.join("/"),
  };
}

function toQuestionRequest(input: OpenCodeQuestionRequest): QuestionRequest {
  return {
    questions: input.questions.map((question) => ({
      id: question.question,
      question: question.question,
      header: question.header,
      multiSelect: question.multiple === true,
      allowCustom: question.custom !== false,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
  };
}

function toOpenCodeAnswers(
  request: QuestionRequest,
  answer: QuestionAnswer,
): OpenCodeQuestionAnswer[] {
  return request.questions.map((question) => {
    const value = answer.answers[question.id];
    if (Array.isArray(value)) {
      return value;
    }
    return value ? [value] : [];
  });
}

function toPermissionRequest(
  request: OpenCodePermissionRequest,
): PermissionRequest {
  return {
    id: request.id,
    tool: request.permission,
    input: {
      patterns: request.patterns,
      metadata: request.metadata,
      always: request.always,
    },
    description: request.permission,
  };
}

function extractEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.delta":
    case "message.part.updated":
    case "message.part.removed":
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
    case "session.status":
    case "session.idle":
    case "session.error":
    case "session.diff":
      return event.properties.sessionID;
    case "session.created":
    case "session.updated":
    case "session.deleted":
    case "session.next.prompted":
    case "session.next.synthetic":
    case "session.next.shell.started":
    case "session.next.shell.ended":
    case "session.next.step.started":
    case "session.next.step.ended":
    case "session.next.step.failed":
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended":
    case "session.next.tool.input.started":
    case "session.next.tool.input.delta":
    case "session.next.tool.input.ended":
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed":
    case "session.next.retried":
    case "session.next.compaction.started":
    case "session.next.compaction.delta":
    case "session.next.compaction.ended":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

function extractAssistantText(parts: Part[]): string {
  return parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

function extractMessageUsage(message: Message): TokenUsage {
  if (message.role !== "assistant") {
    return defaultUsage();
  }

  return {
    inputTokens: message.tokens.input,
    outputTokens: message.tokens.output,
    costUsd: message.cost,
  };
}

function extractOpenCodeErrorMessage(error: unknown): string {
  const record = error != null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : undefined;

  const directMessage = typeof record?.message === "string" ? record.message : undefined;
  if (directMessage) {
    return directMessage;
  }

  const data = record?.data;
  if (data != null && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string") {
    return (data as Record<string, unknown>).message as string;
  }

  return JSON.stringify(error);
}

function formatOpenCodeApiError(error: unknown): string {
  const message = extractOpenCodeErrorMessage(error);
  const record = error != null && typeof error === "object"
    ? error as Record<string, unknown>
    : undefined;
  const status = typeof record?.status === "number" ? record.status : undefined;
  const code = typeof record?.code === "string" ? record.code : undefined;
  const suffix = [
    status !== undefined ? `status ${status}` : undefined,
    code,
  ].filter((value): value is string => Boolean(value)).join(", ");

  return suffix ? `${message} (${suffix})` : message;
}

function formatOpenCodeRetryError(input: {
  attempt: number;
  error: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseBody?: string;
  };
}): string {
  const details = [
    input.error.statusCode !== undefined ? `status ${input.error.statusCode}` : undefined,
    input.error.isRetryable ? "retryable" : "not retryable",
  ].filter((value): value is string => Boolean(value)).join(", ");
  const body = input.error.responseBody?.trim();
  const bodySuffix = body ? `: ${body.slice(0, 240)}` : "";
  return `provider retry attempt ${input.attempt}: ${input.error.message}${details ? ` (${details})` : ""}${bodySuffix}`;
}

function getErrorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  if (typeof record.code === "string") {
    return record.code;
  }

  const cause = record.cause;
  if (cause != null && typeof cause === "object") {
    const causeCode = (cause as Record<string, unknown>).code;
    if (typeof causeCode === "string") {
      return causeCode;
    }
  }

  return undefined;
}

function isAbortLikeError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || getErrorCode(error) === "ABORT_ERR";
}

function formatOpenCodeStreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = getErrorCode(error);

  if (code === "UND_ERR_BODY_TIMEOUT") {
    return `${message} (${code}). OpenCode event stream timed out before the turn completed.`;
  }

  return code ? `${message} (${code})` : message;
}

function toStatusMessage(status: OpenCodeSessionStatus): string {
  if (status.type === "busy") {
    return "busy";
  }

  if (status.type === "idle") {
    return "idle";
  }

  return `retry ${status.attempt}: ${status.message}`;
}

function formatOpenCodeSessionStatus(status: OpenCodeSessionStatus): string {
  if (status.type !== "retry") {
    return toStatusMessage(status);
  }

  const action = status.action;
  const actionText = action
    ? ` ${action.title}: ${action.message}${action.link ? ` ${action.link}` : ""}`
    : "";
  const nextText = status.next > 0 ? ` retrying in ${Math.ceil(status.next / 1000)}s` : "";
  return `retry ${status.attempt}: ${status.message}.${actionText}${nextText}`.trim();
}

function toFileChangeKind(kind: "add" | "change" | "unlink" | "added" | "deleted" | "modified" | undefined): "add" | "update" | "delete" {
  switch (kind) {
    case "add":
    case "added":
      return "add";
    case "unlink":
    case "deleted":
      return "delete";
    case "change":
    case "modified":
    default:
      return "update";
  }
}

function isWriteLikePermission(permission: string): boolean {
  const normalized = permission.toLowerCase();
  return normalized.includes("write")
    || normalized.includes("edit")
    || normalized.includes("patch")
    || normalized.includes("delete")
    || normalized.includes("remove")
    || normalized.includes("rename")
    || normalized.includes("move");
}

function getOpenCodeStatusEvents(event: OpenCodeEvent): AdapterEvent[] {
  switch (event.type) {
    case "session.created":
      return [{
        type: "status",
        category: "session",
        message: `created ${event.properties.info.title}`,
        data: event.properties.info,
      }];
    case "session.updated":
      return [{
        type: "status",
        category: "session",
        message: `updated ${event.properties.info.title}`,
        data: event.properties.info,
      }];
    case "session.deleted":
      return [{
        type: "status",
        category: "session",
        message: `deleted ${event.properties.info.title}`,
        data: event.properties.info,
      }];
    case "session.status":
      return [{
        type: "status",
        category: "session",
        message: toStatusMessage(event.properties.status),
        data: event.properties.status,
      }];
    case "session.compacted":
      return [{
        type: "status",
        category: "compaction",
        message: "session compacted",
      }];
    case "session.next.prompted":
      return [{
        type: "status",
        category: "session",
        message: "prompt accepted",
        data: event.properties.prompt,
      }];
    case "session.next.synthetic":
      return [{
        type: "status",
        category: "session",
        message: "synthetic context added",
        data: event.properties.text,
      }];
    case "session.next.step.started":
      return [{
        type: "status",
        category: "step",
        message: `${event.properties.agent} ${event.properties.model.providerID}/${event.properties.model.id}`,
        data: event.properties,
      }];
    case "session.next.step.ended":
      return [{
        type: "status",
        category: "step",
        message: `finished: ${event.properties.finish}`,
        data: event.properties,
      }];
    case "session.next.step.failed":
      return [{
        type: "error",
        error: event.properties.error.message,
      }];
    case "session.next.reasoning.started":
      return [{
        type: "status",
        category: "reasoning",
        message: "started",
        data: event.properties.reasoningID,
      }];
    case "session.next.reasoning.ended":
      return [{
        type: "status",
        category: "reasoning",
        message: "ended",
        data: event.properties.reasoningID,
      }];
    case "session.next.tool.input.started":
      return [{
        type: "status",
        category: "tool",
        message: `${event.properties.name} input started`,
        data: event.properties,
      }];
    case "session.next.tool.input.ended":
      return [{
        type: "status",
        category: "tool",
        message: "input ready",
        data: event.properties,
      }];
    case "session.next.tool.progress":
      return [{
        type: "status",
        category: "tool",
        message: `progress ${event.properties.callID}`,
        data: event.properties,
      }];
    case "session.next.retried":
      return [
        {
          type: "status",
          category: "retry",
          message: `attempt ${event.properties.attempt}: ${event.properties.error.message}`,
          data: event.properties,
        },
        {
          type: "error",
          error: formatOpenCodeRetryError(event.properties),
        },
      ];
    case "session.next.compaction.started":
      return [{
        type: "status",
        category: "compaction",
        message: `${event.properties.reason} compaction started`,
      }];
    case "session.next.compaction.ended":
      return [{
        type: "status",
        category: "compaction",
        message: "compaction ended",
      }];
    case "permission.replied":
      return [{
        type: "status",
        category: "permission",
        message: `reply ${event.properties.reply}`,
        data: event.properties,
      }];
    case "question.replied":
      return [{
        type: "status",
        category: "question",
        message: "answered",
        data: event.properties,
      }];
    case "question.rejected":
      return [{
        type: "status",
        category: "question",
        message: "rejected",
        data: event.properties,
      }];
    case "todo.updated":
      return [{
        type: "status",
        category: "todo",
        message: `${event.properties.todos.length} todo(s) updated`,
        data: event.properties.todos,
      }];
    case "command.executed":
      return [{
        type: "status",
        category: "command",
        message: `${event.properties.name} ${event.properties.arguments}`.trim(),
        data: event.properties,
      }];
    case "session.diff":
      return [{
        type: "status",
        category: "diff",
        message: `${event.properties.diff.length} file(s) in diff`,
        data: event.properties.diff,
      }];
    case "message.part.updated": {
      const { part } = event.properties;

      switch (part.type) {
        case "subtask":
          return [{
            type: "status",
            category: "subtask",
            message: `${part.agent}: ${part.description}`,
            data: part,
          }];
        case "agent":
          return [{
            type: "status",
            category: "agent",
            message: part.name,
            data: part,
          }];
        case "retry":
          return [{
            type: "status",
            category: "retry",
            message: `attempt ${part.attempt}`,
            data: part,
          }];
        case "step-start":
          return [{
            type: "status",
            category: "step",
            message: "started",
            data: part,
          }];
        case "step-finish":
          return [{
            type: "status",
            category: "step",
            message: `finished: ${part.reason}`,
            data: part,
          }];
        case "compaction":
          return [{
            type: "status",
            category: "compaction",
            message: part.auto ? "auto compaction" : "manual compaction",
            data: part,
          }];
        default:
          return [];
      }
    }
    default:
      return [];
  }
}

async function resolvePermissionDecision(
  config: AdapterSessionConfig,
  request: PermissionRequest,
): Promise<PermissionDecision> {
  if (config.permissions?.readOnly === true && isWriteLikePermission(request.tool)) {
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
    message: "No permission handler configured for OpenCode adapter session.",
  };
}

export class OpenCodeAdapterSession implements AdapterSession {
  readonly provider = "opencode" as const;

  private readonly pendingPrompts: string[] = [];
  private readonly mergedSystemPrompt: string;
  private sessionId: string | undefined;
  private closed = false;
  private active = false;
  private eventAbortController: AbortController | null = null;
  private stopStreamTimer: ReturnType<typeof setTimeout> | null = null;
  private released = false;

  constructor(
    private readonly config: AdapterSessionConfig,
    private readonly client: OpenCodeHandle["client"],
    sessionId: string,
    private readonly onClose?: () => Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.mergedSystemPrompt = mergeSystemPrompt({
      systemPrompt: this.config.systemPrompt,
      runMode: this.config.runMode,
      questionMode: this.config.questionMode,
    });
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  async send(prompt: string): Promise<void> {
    if (this.closed) {
      throw new Error("OpenCode adapter session is closed.");
    }
    this.pendingPrompts.push(prompt);
  }

  private clearPendingStreamStop(): void {
    if (this.stopStreamTimer) {
      clearTimeout(this.stopStreamTimer);
      this.stopStreamTimer = null;
    }
  }

  private scheduleStreamStop(): void {
    this.clearPendingStreamStop();
    this.stopStreamTimer = setTimeout(() => {
      this.eventAbortController?.abort();
    }, 250);
    this.stopStreamTimer.unref?.();
  }

  private async readCurrentSessionStatus(): Promise<OpenCodeSessionStatus | undefined> {
    if (!this.sessionId) {
      return undefined;
    }

    const response = await this.client.session.status({
      directory: this.config.cwd,
    });
    return response.data?.[this.sessionId];
  }

  async *stream(): AsyncGenerator<AdapterEvent, void, undefined> {
    const prompt = this.pendingPrompts.shift();
    if (!prompt || this.closed || !this.sessionId) {
      return;
    }

    this.eventAbortController = new AbortController();

    const events = await this.client.event.subscribe(
      {
        directory: this.config.cwd,
      },
      {
        signal: this.eventAbortController.signal,
      },
    );

    const promptPromise = this.client.session.prompt({
      sessionID: this.sessionId,
      directory: this.config.cwd,
      ...(toOpenCodeModel(this.config.model)
        ? { model: toOpenCodeModel(this.config.model) }
        : {}),
      ...(this.mergedSystemPrompt ? { system: this.mergedSystemPrompt } : {}),
      parts: [{ type: "text", text: prompt }],
    });
    const promptResultPromise = promptPromise.finally(() => {
      this.scheduleStreamStop();
    });
    void promptResultPromise.catch(() => {
      // The result is awaited below when the event stream reaches a normal
      // terminal state. If the event stream itself fails first, keep the
      // prompt request from surfacing as an unhandled rejection.
    });

    this.active = true;

    yield {
      type: "session.started",
      provider: this.provider,
      sessionId: this.sessionId,
      model: this.config.model,
    };

    try {
      try {
        const iterator = events.stream[Symbol.asyncIterator]();
        let nextEvent = iterator.next();
        while (true) {
          const next = await Promise.race([
            nextEvent.then((result) => ({ type: "event" as const, result })),
            delay(getOpenCodeWaitHeartbeatMs()),
          ]);

          if (next === "heartbeat") {
            let status: OpenCodeSessionStatus | undefined;
            try {
              status = await this.readCurrentSessionStatus();
            } catch (error) {
              yield {
                type: "error",
                error: `failed to read OpenCode session status: ${formatOpenCodeStreamError(error)}`,
              };
            }

            if (status) {
              const message = formatOpenCodeSessionStatus(status);
              yield {
                type: "status",
                category: "session",
                message,
                data: status,
              };
              if (status.type === "retry") {
                yield {
                  type: "error",
                  error: message,
                };
              }
              continue;
            }

            yield {
              type: "status",
              category: "session",
              message: "still waiting for provider events",
            };
            continue;
          }

          if (next.result.done) {
            break;
          }

          const event = next.result.value;
          nextEvent = iterator.next();
          const eventSessionId = extractEventSessionId(event);
          if (eventSessionId && eventSessionId !== this.sessionId) {
            continue;
          }

          yield {
            type: "provider.event",
            provider: this.provider,
            eventType: event.type,
            data: event,
          };

          for (const statusEvent of getOpenCodeStatusEvents(event)) {
            yield statusEvent;
          }

          if (event.type === "message.part.delta" && event.properties.field === "text") {
            yield { type: "text.delta", text: event.properties.delta };
            continue;
          }

          if (event.type === "session.next.text.delta") {
            yield { type: "text.delta", text: event.properties.delta };
            continue;
          }

          if (event.type === "session.next.reasoning.delta") {
            yield { type: "thinking", text: event.properties.delta };
            continue;
          }

          if (event.type === "session.next.compaction.delta") {
            yield { type: "thinking", text: event.properties.text };
            continue;
          }

          if (event.type === "session.next.shell.ended") {
            yield {
              type: "command",
              command: event.properties.callID,
              exitCode: 0,
              output: event.properties.output,
            };
            continue;
          }

          if (event.type === "session.next.tool.called") {
            yield {
              type: "tool.use",
              tool: event.properties.tool,
              input: event.properties.input,
            };
            continue;
          }

          if (event.type === "session.next.tool.success") {
            yield {
              type: "tool.result",
              tool: event.properties.callID,
              output: event.properties.structured,
            };
            continue;
          }

          if (event.type === "session.next.tool.failed") {
            yield {
              type: "tool.result",
              tool: event.properties.callID,
              output: event.properties.error.message,
            };
            continue;
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part;

            if (part.type === "reasoning") {
              yield { type: "thinking", text: part.text };
              continue;
            }

            if (part.type === "tool") {
              if (part.state.status === "completed") {
                yield {
                  type: "tool.result",
                  tool: part.tool,
                  output: part.state.output,
                };
              } else {
                yield {
                  type: "tool.use",
                  tool: part.tool,
                  input: part.state.input,
                };
              }
              continue;
            }

            if (part.type === "patch") {
              for (const file of part.files) {
                yield {
                  type: "file.change",
                  path: file,
                  kind: "update",
                };
              }
              continue;
            }
          }

          if (event.type === "permission.asked") {
            const request = toPermissionRequest(event.properties);
            yield { type: "permission.request", request };
            const decision = await resolvePermissionDecision(this.config, request);
            await this.client.permission.reply({
              requestID: event.properties.id,
              directory: this.config.cwd,
              reply: decision.behavior === "allow" ? "always" : "reject",
              ...(decision.message ? { message: decision.message } : {}),
            });
            continue;
          }

          if (event.type === "question.asked") {
            const request = toQuestionRequest(event.properties);
            yield { type: "question", request };
            const answer = await this.config.onQuestion?.(request);

            if (!answer) {
              await this.client.question.reject({
                requestID: event.properties.id,
                directory: this.config.cwd,
              });
            } else {
              await this.client.question.reply({
                requestID: event.properties.id,
                directory: this.config.cwd,
                answers: toOpenCodeAnswers(request, answer),
              });
            }
            continue;
          }

          if (event.type === "file.edited") {
            yield {
              type: "file.change",
              path: event.properties.file,
              kind: "update",
            };
            continue;
          }

          if (event.type === "file.watcher.updated") {
            yield {
              type: "file.change",
              path: event.properties.file,
              kind: toFileChangeKind(event.properties.event),
            };
            continue;
          }

          if (event.type === "session.diff") {
            for (const file of event.properties.diff) {
              yield {
                type: "file.change",
                path: file.file ?? "unknown",
                kind: toFileChangeKind(file.status),
              };
            }
            continue;
          }

          if (event.type === "session.error") {
            yield {
              type: "error",
              error: extractOpenCodeErrorMessage(event.properties.error),
            };
            break;
          }

          if (event.type === "session.idle") {
            yield {
              type: "status",
              category: "session",
              message: "idle",
            };
            break;
          }
        }
      } catch (error) {
        if (!isAbortLikeError(error)) {
          this.eventAbortController.abort();
          yield {
            type: "error",
            error: formatOpenCodeStreamError(error),
          };
          return;
        }
      }

      const promptResponse = await promptResultPromise;
      if (promptResponse.error) {
        this.active = false;
        yield { type: "error", error: formatOpenCodeApiError(promptResponse.error) };
        return;
      }

      const messagesResponse = await this.client.session.messages({
        sessionID: this.sessionId,
        directory: this.config.cwd,
        limit: 25,
      });

      const messages = messagesResponse.data ?? [];
      const assistantMessages = messages.filter((entry) => entry.info.role === "assistant");
      const latestAssistant = assistantMessages.at(-1);

      const text = latestAssistant ? extractAssistantText(latestAssistant.parts) : "";
      const usage = latestAssistant ? extractMessageUsage(latestAssistant.info) : defaultUsage();

      this.active = false;

      yield {
        type: "completed",
        result: {
          provider: this.provider,
          sessionId: this.sessionId,
          text,
          usage,
          raw: promptResponse.data,
        },
      };
    } finally {
      this.active = false;
      this.clearPendingStreamStop();
      this.eventAbortController?.abort();
      this.eventAbortController = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this.active) {
      return;
    }
    this.clearPendingStreamStop();
    this.eventAbortController?.abort();
    await this.client.session.abort({
      sessionID: this.sessionId,
      directory: this.config.cwd,
    });
    this.active = false;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearPendingStreamStop();
    this.eventAbortController?.abort();
    try {
      if (this.sessionId) {
        try {
          await this.client.session.delete({
            sessionID: this.sessionId,
            directory: this.config.cwd,
          });
        } catch {
          // Best-effort cleanup.
        }
      }
    } finally {
      if (!this.released) {
        this.released = true;
        await this.onClose?.();
      }
    }
  }
}

export class OpenCodeAdapter implements AdapterFactory {
  async createSession(config: AdapterSessionConfig): Promise<AdapterSession> {
    const handle = await createOpenCodeHandle();
    let released = false;
    const releaseSessionHandle = async (): Promise<void> => {
      if (released) {
        return;
      }
      released = true;
      handle.server.close();
      await handle.dispatcher.close();
    };

    try {
      const response = await handle.client.session.create({
        directory: config.cwd,
        title: "Kyros session",
      });

      if (response.error || !response.data) {
        throw new Error(`Failed to create OpenCode session: ${JSON.stringify(response.error)}`);
      }

      return new OpenCodeAdapterSession(config, handle.client, response.data.id, releaseSessionHandle);
    } catch (error) {
      await releaseSessionHandle();
      throw error;
    }
  }

  async listModels(input: { cwd: string }): Promise<AdapterModelOption[]> {
    if (
      openCodeModelCache
      && openCodeModelCache.cwd === input.cwd
      && Date.now() - openCodeModelCache.timestamp < 5 * 60 * 1000
    ) {
      return openCodeModelCache.options;
    }

    try {
      const handle = await getOpenCodeHandle();
      const response = await handle.client.config.providers(
        { directory: input.cwd },
        {
          throwOnError: true,
        },
      );
      const data = response.data;

      const modelOptions: AdapterModelOption[] = [{
        label: "Default",
        description: "Use OpenCode's configured default model.",
      }];

      if (!data) {
        return modelOptions;
      }

      const providerOptions = await Promise.all(data.providers.map(async (provider) => {
        const defaultModel = data.default[provider.id];
        const fallbackModelIds = Object.keys(provider.models).sort((left, right) => {
          const leftModel = provider.models[left]!;
          const rightModel = provider.models[right]!;
          return leftModel.name.localeCompare(rightModel.name);
        });

        let modelValues: string[];
        try {
          modelValues = await listOpenCodeCliModels(provider.id);
        } catch {
          modelValues = fallbackModelIds.map((modelId) => `${provider.id}/${modelId}`);
        }

        return modelValues.map((value) => {
          const prefix = `${provider.id}/`;
          const modelId = value.startsWith(prefix) ? value.slice(prefix.length) : value;
          const model = provider.models[modelId];
          const label = model
            ? `${provider.name}: ${model.name}`
            : value;
          const suffix = model
            ? [
                model.family,
                model.status !== "active" ? model.status : undefined,
                defaultModel === model.id ? "default for provider" : undefined,
              ].filter(Boolean).join(" · ")
            : (defaultModel === modelId ? "default for provider" : undefined);

          return {
            value,
            label,
            description: [
              value,
              suffix || undefined,
            ].filter(Boolean).join(" · "),
            group: provider.name,
          } satisfies AdapterModelOption;
        });
      }));

      const combined = [...modelOptions, ...providerOptions.flat()];
      openCodeModelCache = {
        cwd: input.cwd,
        timestamp: Date.now(),
        options: combined,
      };
      return combined;
    } finally {
      await closeOpenCodeHandleIfIdle();
    }
  }
}
