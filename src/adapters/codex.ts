import { Codex, type ModelReasoningEffort, type Thread, type ThreadEvent, type ThreadItem, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterEvent, AdapterFactory, AdapterModelOption, AdapterRunResult, AdapterSession, AdapterSessionConfig, TokenUsage } from "./types.js";
import { mergeSystemPrompt } from "./prompting.js";

const CODEX_DEFAULT_MODEL_OPTION: AdapterModelOption = {
  label: "Default",
  description: "Use the Codex SDK default model.",
};

const CODEX_FALLBACK_MODEL_OPTIONS: AdapterModelOption[] = [
  {
    value: "gpt-5-codex",
    label: "GPT-5 Codex",
    description: "OpenAI Codex model for agentic coding work.",
  },
  {
    value: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    description: "Newer GPT-5 Codex variant for coding tasks.",
  },
  {
    value: "gpt-5.1-codex",
    label: "GPT-5.1 Codex",
    description: "Earlier GPT-5.1 Codex model.",
  },
  {
    value: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex Mini",
    description: "Smaller and cheaper GPT-5.1 Codex variant.",
  },
  {
    value: "gpt-5",
    label: "GPT-5",
    description: "General-purpose GPT-5 model.",
  },
  {
    value: "gpt-5-mini",
    label: "GPT-5 Mini",
    description: "Smaller GPT-5 model for faster and cheaper runs.",
  },
];

interface CodexModelsCache {
  models?: Array<{
    slug?: string;
    display_name?: string;
    description?: string;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{
      effort?: string;
      description?: string;
    }>;
    visibility?: string;
    priority?: number;
  }>;
}

let codexModelsCachePromise: Promise<CodexModelsCache | null> | null = null;
let codexConfigEffortPromise: Promise<ModelReasoningEffort | undefined> | null = null;
const SYNTHETIC_STREAM_CHUNK_SIZE = 72;
const SYNTHETIC_STREAM_THRESHOLD = 96;
const SYNTHETIC_STREAM_MAX_CHUNKS = 24;

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

function isModelReasoningEffort(value: string | undefined): value is ModelReasoningEffort {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

async function readCodexModelsCache(): Promise<CodexModelsCache | null> {
  if (!codexModelsCachePromise) {
    codexModelsCachePromise = readFile(
      join(homedir(), ".codex", "models_cache.json"),
      "utf-8",
    )
      .then((raw) => JSON.parse(raw) as CodexModelsCache)
      .catch(() => null);
  }

  return codexModelsCachePromise;
}

async function readConfiguredReasoningEffort(): Promise<ModelReasoningEffort | undefined> {
  if (!codexConfigEffortPromise) {
    codexConfigEffortPromise = readFile(
      join(homedir(), ".codex", "config.toml"),
      "utf-8",
    )
      .then((raw) => {
        const match = raw.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
        const value = match?.[1];
        return isModelReasoningEffort(value) ? value : undefined;
      })
      .catch(() => undefined);
  }

  return codexConfigEffortPromise;
}

function chooseReasoningEffortFromMetadata(input: {
  configuredEffort?: ModelReasoningEffort;
  defaultEffort?: string;
  supportedEfforts: ModelReasoningEffort[];
}): ModelReasoningEffort | undefined {
  if (input.supportedEfforts.length === 0) {
    return input.configuredEffort;
  }

  if (input.configuredEffort && input.supportedEfforts.includes(input.configuredEffort)) {
    return input.configuredEffort;
  }

  if (isModelReasoningEffort(input.defaultEffort) && input.supportedEfforts.includes(input.defaultEffort)) {
    return input.defaultEffort;
  }

  if (input.supportedEfforts.includes("medium")) {
    return "medium";
  }

  return input.supportedEfforts[0];
}

async function resolveCodexReasoningEffort(
  model: string | undefined,
): Promise<ModelReasoningEffort | undefined> {
  const configuredEffort = await readConfiguredReasoningEffort();

  if (!model) {
    return configuredEffort;
  }

  const cache = await readCodexModelsCache();
  const metadata = cache?.models?.find((entry) => entry.slug === model);
  if (metadata) {
    const supportedEfforts = (metadata.supported_reasoning_levels ?? [])
      .flatMap((level) => (isModelReasoningEffort(level.effort) ? [level.effort] : []));

    return chooseReasoningEffortFromMetadata({
      configuredEffort,
      defaultEffort: metadata.default_reasoning_level,
      supportedEfforts,
    });
  }

  if (configuredEffort === "xhigh" && model.includes("mini")) {
    return "medium";
  }

  return configuredEffort ?? "medium";
}

function toCodexPrompt(config: AdapterSessionConfig, prompt: string): string {
  const mergedSystemPrompt = mergeSystemPrompt({
    systemPrompt: config.systemPrompt,
    runMode: config.runMode,
    questionMode: config.questionMode,
  });

  return mergedSystemPrompt
    ? `${mergedSystemPrompt}\n\nUser request:\n${prompt}`
    : prompt;
}

function toCodexThreadOptions(
  config: AdapterSessionConfig,
  reasoningEffort: ModelReasoningEffort | undefined,
): ThreadOptions {
  const sandboxMode = config.permissions?.readOnly === true
    ? "read-only"
    : (
      config.permissions?.disableSandbox === true ||
      config.permissions?.mode === "bypass"
        ? "danger-full-access"
        : "workspace-write"
    );

  return {
    ...(config.model ? { model: config.model } : {}),
    ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
    workingDirectory: config.cwd,
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy:
      config.permissions?.mode === "interactive"
        ? "on-request"
        : "never",
    ...(config.permissions?.allowedReadRoots?.length
      ? { additionalDirectories: config.permissions.allowedReadRoots }
      : {}),
    ...(config.permissions?.allowedDomains?.length || config.permissions?.allowLocalNetwork
      ? { networkAccessEnabled: true }
      : {}),
  };
}

type CodexItemEventType = "item.started" | "item.updated" | "item.completed";

export function splitTextForSyntheticStreaming(text: string): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= SYNTHETIC_STREAM_THRESHOLD) {
    return [text];
  }

  const tokens = text.match(/\S+\s*|\s+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (current && current.length + token.length > SYNTHETIC_STREAM_CHUNK_SIZE) {
      chunks.push(current);
      current = token;
      continue;
    }

    current += token;
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length <= SYNTHETIC_STREAM_MAX_CHUNKS) {
    return chunks;
  }

  const balancedChunkSize = Math.ceil(text.length / SYNTHETIC_STREAM_MAX_CHUNKS);
  const balanced: string[] = [];

  for (let index = 0; index < text.length; index += balancedChunkSize) {
    balanced.push(text.slice(index, index + balancedChunkSize));
  }

  return balanced;
}

function mapCodexItem(item: ThreadItem): AdapterEvent[] {
  switch (item.type) {
    case "reasoning":
      return [{ type: "thinking", text: item.text }];
    case "command_execution":
      return item.status === "completed" || item.status === "failed"
        ? [{
            type: "command",
            command: item.command,
            output: item.aggregated_output,
            exitCode: item.exit_code ?? (item.status === "completed" ? 0 : 1),
          }]
        : [
            {
              type: "status",
              category: "command",
              message: `${item.status} ${item.command}`,
              data: item,
            },
            {
              type: "tool.use",
              tool: "command_execution",
              input: { command: item.command, status: item.status },
            },
          ];
    case "file_change":
      return item.status === "completed"
        ? item.changes.map((change) => ({
            type: "file.change",
            path: change.path,
            kind: change.kind,
          }))
        : [{
            type: "status",
            category: "patch",
            message: `failed ${item.changes.length} change(s)`,
            data: item,
          }];
    case "mcp_tool_call":
      return item.status === "completed"
        ? [{
            type: "tool.result",
            tool: `${item.server}:${item.tool}`,
            output: item.result ?? item.error ?? null,
          }]
        : [
            {
              type: "status",
              category: "tool",
              message: `${item.status} ${item.server}:${item.tool}`,
              data: item,
            },
            {
              type: "tool.use",
              tool: `${item.server}:${item.tool}`,
              input: item.arguments,
            },
          ];
    case "todo_list":
      return [{
        type: "status",
        category: "todo",
        message: `${item.items.length} todo item(s)`,
        data: item.items,
      }];
    case "web_search":
      return [
        {
          type: "status",
          category: "search",
          message: item.query,
          data: item,
        },
        { type: "tool.use", tool: "web_search", input: { query: item.query } },
      ];
    case "error":
      return [{ type: "error", error: item.message }];
    default:
      return [];
  }
}

async function *emitCodexItemEvents(
  item: ThreadItem,
  itemTextState: Map<string, string>,
  eventType: CodexItemEventType,
): AsyncGenerator<AdapterEvent, void, undefined> {
  if (item.type === "agent_message") {
    const previous = itemTextState.get(item.id) ?? "";
    const delta = appendOnlyDelta(previous, item.text);
    itemTextState.set(item.id, item.text);

    if (delta) {
      const chunks = eventType === "item.completed" && !previous
        ? splitTextForSyntheticStreaming(delta)
        : [delta];

      for (let index = 0; index < chunks.length; index += 1) {
        yield { type: "text.delta", text: chunks[index]! };
        if (eventType === "item.completed" && chunks.length > 1 && index < chunks.length - 1) {
          await delay(0);
        }
      }
    }

    if (eventType === "item.completed") {
      yield { type: "message.completed", text: item.text };
    }
    return;
  }

  for (const event of mapCodexItem(item)) {
    yield event;
  }
}

export async function collectCodexItemEvents(
  item: ThreadItem,
  eventType: CodexItemEventType,
  itemTextState: Map<string, string> = new Map(),
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const event of emitCodexItemEvents(item, itemTextState, eventType)) {
    events.push(event);
  }
  return events;
}

class CodexAdapterSession implements AdapterSession {
  readonly provider = "codex" as const;

  private readonly pendingPrompts: string[] = [];
  private readonly codex = new Codex();
  private readonly thread: Thread;
  private readonly itemTextState = new Map<string, string>();
  private abortController: AbortController | null = null;
  private closed = false;
  private threadId: string | undefined;

  constructor(
    private readonly config: AdapterSessionConfig,
    threadOptions: ThreadOptions,
  ) {
    this.thread = this.codex.startThread(threadOptions);
  }

  get id(): string | undefined {
    return this.threadId ?? this.thread.id ?? undefined;
  }

  async send(prompt: string): Promise<void> {
    if (this.closed) {
      throw new Error("Codex adapter session is closed.");
    }
    this.pendingPrompts.push(prompt);
  }

  async *stream(): AsyncGenerator<AdapterEvent, void, undefined> {
    const prompt = this.pendingPrompts.shift();
    if (!prompt || this.closed) {
      return;
    }

    this.abortController = new AbortController();
    let usage = defaultUsage();
    let finalText = "";
    let emittedStart = false;

    try {
      const result = await this.thread.runStreamed(toCodexPrompt(this.config, prompt), {
        signal: this.abortController.signal,
      });

      for await (const event of result.events) {
        yield {
          type: "provider.event",
          provider: this.provider,
          eventType: event.type,
          data: event,
        };

        if (event.type === "thread.started") {
          this.threadId = event.thread_id;
          if (!emittedStart) {
            emittedStart = true;
            yield {
              type: "session.started",
              provider: this.provider,
              sessionId: this.threadId,
              model: this.config.model,
            };
          }
          yield {
            type: "status",
            category: "session",
            message: `thread ${event.thread_id}`,
          };
          continue;
        }

        if (event.type === "turn.started") {
          yield {
            type: "status",
            category: "turn",
            message: "started",
          };
          continue;
        }

        if ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed")) {
          for await (const itemEvent of emitCodexItemEvents(event.item, this.itemTextState, event.type)) {
            yield itemEvent;
            if (itemEvent.type === "message.completed") {
              finalText = itemEvent.text;
            }
          }
          continue;
        }

        if (event.type === "turn.completed") {
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            costUsd: 0,
          };
          yield {
            type: "status",
            category: "turn",
            message: "completed",
            data: event.usage,
          };
          continue;
        }

        if (event.type === "turn.failed") {
          yield {
            type: "status",
            category: "turn",
            message: "failed",
            data: event.error,
          };
          yield { type: "error", error: event.error.message };
          continue;
        }

        if (event.type === "error") {
          yield { type: "error", error: event.message };
        }
      }

      yield {
        type: "completed",
        result: {
          provider: this.provider,
          sessionId: this.id,
          text: finalText,
          usage,
        },
      };
    } finally {
      this.abortController = null;
    }
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController?.abort();
    this.abortController = null;
  }
}

export class CodexAdapter implements AdapterFactory {
  async createSession(config: AdapterSessionConfig): Promise<AdapterSession> {
    const reasoningEffort = await resolveCodexReasoningEffort(config.model);
    return new CodexAdapterSession(
      config,
      toCodexThreadOptions(config, reasoningEffort),
    );
  }

  async listModels(): Promise<AdapterModelOption[]> {
    try {
      const cache = await readCodexModelsCache();
      const discoveredOptions = (cache?.models ?? [])
        .filter(
          (model) =>
            model.visibility === "list" && typeof model.slug === "string",
        )
        .sort((left, right) => (left.priority ?? 99) - (right.priority ?? 99))
        .map((model) => ({
          value: model.slug!,
          label: model.display_name || model.slug!,
          description: model.description || `Use ${model.display_name || model.slug!}.`,
        }));

      return dedupeModelOptions([
        CODEX_DEFAULT_MODEL_OPTION,
        ...(discoveredOptions.length > 0
          ? discoveredOptions
          : CODEX_FALLBACK_MODEL_OPTIONS),
      ]);
    } catch {
      return [CODEX_DEFAULT_MODEL_OPTION, ...CODEX_FALLBACK_MODEL_OPTIONS];
    }
  }
}
