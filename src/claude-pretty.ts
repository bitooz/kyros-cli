import type { AdapterEvent } from "./adapters/index.js";
import { basename } from "node:path";

interface StreamState {
  textOpen: boolean;
}

interface ToolCallState {
  id: string;
  name: string;
  description?: string;
  subagentType?: string;
  taskId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  return `${Math.round(seconds)}s`;
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function extractToolResultText(result: unknown): string | undefined {
  const record = asRecord(result);
  const content = record?.content;

  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const entry of content) {
    const block = asRecord(entry);
    if (asString(block?.type) !== "text") {
      continue;
    }
    const text = asString(block?.text);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function extractUserToolResultText(messageBlock: Record<string, unknown>): string | undefined {
  const content = messageBlock.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  for (const entry of content) {
    const block = asRecord(entry);
    if (asString(block?.type) !== "text") {
      continue;
    }
    const text = asString(block?.text);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `Bash(${truncate(asString(input.description) ?? asString(input.command) ?? "command", 90)})`;
    case "Glob":
      return `Glob(pattern: "${truncate(asString(input.pattern) ?? "*", 80)}")`;
    case "Grep":
      return `Grep(pattern: "${truncate(asString(input.pattern) ?? "", 80)}")`;
    case "Read": {
      const path = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
      return path ? `Read(${basename(path)})` : "Read(file)";
    }
    case "Write": {
      const path = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path);
      return path ? `Write(${basename(path)})` : "Write(file)";
    }
    default:
      return input && Object.keys(input).length > 0
        ? `${name}(${truncate(JSON.stringify(input), 90)})`
        : name;
  }
}

function summarizeToolResult(call: ToolCallState | undefined, result: unknown, fallbackText: string | undefined): string | undefined {
  const record = asRecord(result);

  if (call?.name === "Agent") {
    const status = asString(record?.status) ?? "completed";
    const agentType = asString(record?.agentType) ?? call.subagentType ?? "Agent";
    const duration = formatDuration(asNumber(record?.totalDurationMs));
    const text = extractToolResultText(record) ?? fallbackText;
    const errorSuffix = text ? `: ${truncate(firstLine(text) ?? text, 140)}` : "";
    return `${agentType} ${status}${duration ? ` in ${duration}` : ""}${errorSuffix}`;
  }

  if (Array.isArray(record?.filenames)) {
    const count = asNumber(record?.numFiles) ?? record!.filenames.length;
    const truncatedResult = record?.truncated === true ? " (truncated)" : "";
    return `Found ${count} files${truncatedResult}`;
  }

  const fileRecord = asRecord(record?.file);
  if (fileRecord) {
    const filePath = asString(fileRecord.filePath);
    const numLines = asNumber(fileRecord.numLines);
    if (filePath) {
      return `Read ${basename(filePath)}${numLines ? ` (${numLines} lines)` : ""}`;
    }
  }

  const filePath = asString(record?.filePath);
  if (filePath) {
    if (call?.name === "Write") {
      return `Wrote ${basename(filePath)}`;
    }
    return `Updated ${basename(filePath)}`;
  }

  const stdout = asString(record?.stdout);
  const stderr = asString(record?.stderr);
  const firstOutput = firstLine(stdout) ?? firstLine(stderr) ?? firstLine(fallbackText);
  if (firstOutput) {
    return truncate(firstOutput, 140);
  }

  return call ? `${call.name} completed` : undefined;
}

function closeOpenText(output: { write(chunk: string): void | boolean }, state: StreamState): void {
  if (state.textOpen) {
    output.write("\n");
    state.textOpen = false;
  }
}

function writeLine(
  output: { write(chunk: string): void | boolean },
  state: StreamState,
  message: string,
): void {
  closeOpenText(output, state);
  output.write(`${message}\n`);
}

function writeDetail(
  output: { write(chunk: string): void | boolean },
  state: StreamState,
  message: string,
): void {
  writeLine(output, state, `  └ ${message}`);
}

export class ClaudePrettyRenderer {
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly taskToToolCall = new Map<string, string>();

  constructor(private readonly output: { write(chunk: string): void | boolean }) {}

  handle(event: AdapterEvent, state: StreamState): boolean {
    switch (event.type) {
      case "text.delta":
        if (!state.textOpen) {
          this.output.write("• ");
          state.textOpen = true;
        }
        this.output.write(event.text);
        return true;
      case "message.completed":
        closeOpenText(this.output, state);
        return true;
      case "thinking":
      case "tool.use":
      case "tool.result":
      case "command":
      case "file.change":
        return true;
      case "status":
        return this.handleStatus(event, state);
      case "provider.event":
        return this.handleProviderEvent(event, state);
      default:
        return false;
    }
  }

  private handleStatus(event: Extract<AdapterEvent, { type: "status" }>, state: StreamState): boolean {
    void event;
    void state;
    return true;
  }

  private handleProviderEvent(
    event: Extract<AdapterEvent, { type: "provider.event" }>,
    state: StreamState,
  ): boolean {
    const payload = asRecord(event.data);
    if (!payload) {
      return true;
    }

    const type = asString(payload.type);
    if (!type) {
      return true;
    }

    if (type === "assistant") {
      this.handleAssistantPayload(payload, state);
      return true;
    }

    if (type === "user") {
      this.handleUserPayload(payload, state);
      return true;
    }

    if (type === "system") {
      this.handleSystemPayload(payload, state);
      return true;
    }

    return true;
  }

  private handleAssistantPayload(payload: Record<string, unknown>, state: StreamState): void {
    const message = asRecord(payload.message);
    const content = Array.isArray(message?.content) ? message.content : [];

    for (const entry of content) {
      const block = asRecord(entry);
      if (!block) {
        continue;
      }

      const blockType = asString(block.type);
      if (blockType !== "tool_use") {
        continue;
      }

      const toolUseId = asString(block.id);
      const name = asString(block.name);
      const input = asRecord(block.input) ?? {};
      if (!toolUseId || !name) {
        continue;
      }

      const call: ToolCallState = {
        id: toolUseId,
        name,
        description: asString(input.description),
        subagentType: asString(input.subagent_type),
      };
      this.toolCalls.set(toolUseId, call);

      if (name === "Agent") {
        const title = call.subagentType ?? "Agent";
        writeLine(
          this.output,
          state,
          `• ${title}${call.description ? ` (${truncate(call.description, 90)})` : ""}`,
        );
        writeDetail(this.output, state, "Initializing...");
        continue;
      }

      writeDetail(this.output, state, summarizeToolUse(name, input));
    }
  }

  private handleUserPayload(payload: Record<string, unknown>, state: StreamState): void {
    const message = asRecord(payload.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const toolUseResult = payload.tool_use_result;

    for (const entry of content) {
      const block = asRecord(entry);
      if (!block || asString(block.type) !== "tool_result") {
        continue;
      }

      const toolUseId = asString(block.tool_use_id);
      const call = toolUseId ? this.toolCalls.get(toolUseId) : undefined;
      const fallbackText = extractUserToolResultText(block);
      const summary = summarizeToolResult(call, toolUseResult, fallbackText);

      if (summary) {
        writeDetail(this.output, state, summary);
      }

      if (toolUseId) {
        this.toolCalls.delete(toolUseId);
      }
    }
  }

  private handleSystemPayload(payload: Record<string, unknown>, state: StreamState): void {
    const subtype = asString(payload.subtype);
    if (!subtype) {
      return;
    }

    switch (subtype) {
      case "task_started": {
        const toolUseId = asString(payload.tool_use_id);
        const taskId = asString(payload.task_id);
        if (toolUseId && taskId) {
          this.taskToToolCall.set(taskId, toolUseId);
          const call = this.toolCalls.get(toolUseId);
          if (call) {
            call.taskId = taskId;
          }
        }
        return;
      }
      case "task_progress": {
        const summary = asString(payload.summary) ?? asString(payload.description);
        const taskId = asString(payload.task_id);
        if (!summary || !taskId) {
          return;
        }
        const toolUseId = this.taskToToolCall.get(taskId);
        if (!toolUseId) {
          return;
        }
        writeDetail(this.output, state, truncate(summary, 120));
        return;
      }
      case "task_notification": {
        const status = asString(payload.status);
        if (status === "completed") {
          return;
        }

        const summary = asString(payload.summary) ?? "task";
        writeDetail(this.output, state, `${summary}: ${status ?? "updated"}`);
        return;
      }
      case "api_retry": {
        const attempt = asNumber(payload.attempt);
        const maxRetries = asNumber(payload.max_retries);
        const retryDelayMs = asNumber(payload.retry_delay_ms);
        const reason = asString(payload.error);
        writeLine(
          this.output,
          state,
          `* Retrying${attempt && maxRetries ? ` (${attempt}/${maxRetries})` : ""}${retryDelayMs ? ` in ${Math.round(retryDelayMs)}ms` : ""}${reason ? ` due to ${reason}` : ""}`,
        );
        return;
      }
      case "status": {
        const permissionMode = asString(payload.permissionMode);
        if (permissionMode) {
          writeLine(this.output, state, `* Permission mode: ${permissionMode}`);
        }
        return;
      }
      default:
        return;
    }
  }
}
