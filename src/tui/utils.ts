import type {
  AdapterPermissionMode,
  AdapterProvider,
  AdapterRunMode,
  QuestionRequest,
} from "../adapters/index.js";
import { basename } from "node:path";
import type {
  InteractionModeOption,
  QuestionDraftState,
  QuestionUiState,
  SlashCommand,
  UiMessage,
} from "./types.js";
import type { TextBufferState } from "./input.js";

export const INTERACTION_MODE_OPTIONS: InteractionModeOption[] = [
  {
    label: "confirm edits",
    permissionMode: "interactive",
    runMode: "execute",
  },
  {
    label: "auto-accept",
    permissionMode: "auto",
    runMode: "execute",
  },
  {
    label: "plan mode",
    permissionMode: "interactive",
    runMode: "plan",
  },
];

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function truncate(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

export function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

export function formatDuration(durationMs: number | undefined): string {
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

export function formatTokens(tokens: number | undefined): string | undefined {
  if (tokens == null || !Number.isFinite(tokens)) {
    return undefined;
  }

  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k tokens`;
  }

  return `${tokens} tokens`;
}

export function hashColor(label: string) {
  const palette = ["blue", "cyan", "green", "magenta", "yellow", "red"] as const;
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return palette[hash % palette.length]!;
}

export function summarizeGenericValue(value: unknown): string {
  if (value == null) {
    return "no details";
  }

  if (typeof value === "string") {
    return truncate(value, 100);
  }

  const record = asRecord(value);
  if (!record) {
    return truncate(JSON.stringify(value), 100);
  }

  if (typeof record.command === "string") {
    return truncate(record.command, 100);
  }

  if (typeof record.pattern === "string") {
    return `pattern: ${truncate(record.pattern, 80)}`;
  }

  if (typeof record.path === "string") {
    return basename(record.path);
  }

  return truncate(JSON.stringify(record), 100);
}

export function pushDetail(details: string[], detail: string | undefined, maxDetails = 4): string[] {
  if (!detail) {
    return details.slice(-maxDetails);
  }

  if (details.at(-1) === detail) {
    return details.slice(-maxDetails);
  }

  return [...details, detail].slice(-maxDetails);
}

export function summarizePaths(paths: string[], maxItems = 3): string[] {
  const visible = paths.slice(0, maxItems).map((path) => basename(path));
  if (paths.length > maxItems) {
    visible.push(`+${paths.length - maxItems} more`);
  }
  return visible;
}

export function summarizeLabeledPaths(
  items: Array<{ label: string; path: string }>,
  maxItems = 3,
): string[] {
  const visible = items
    .slice(0, maxItems)
    .map((item) => `${item.label} ${basename(item.path)}`);

  if (items.length > maxItems) {
    visible.push(`+${items.length - maxItems} more`);
  }

  return visible;
}

export function findMessageIndexById(messages: UiMessage[], id: string): number {
  return messages.findIndex((entry) => entry.id === id);
}

export function getDefaultModelLabel(provider: AdapterProvider): string {
  switch (provider) {
    case "claudeCode":
      return "default";
    case "codex":
      return "sdk default";
    case "opencode":
      return "configured default";
    default:
      return "default";
  }
}

export function formatCurrentModel(provider: AdapterProvider, model: string | undefined): string {
  return model ?? getDefaultModelLabel(provider);
}

export function buildWelcomeMessage(provider: AdapterProvider, model: string | undefined): string {
  void provider;
  void model;
  return "Describe goal.md to start. Approve each file to move to the next one.";
}

export function buildSlashCommands(): SlashCommand[] {
  return [
    {
      name: "/resume",
      description: "Browse and restore a previous session.",
    },
    {
      name: "/teams",
      description: "List global and repo-local saved teams.",
    },
    {
      name: "/team",
      description: "Save, use, run, or set member/provider models for a named team definition.",
    },
    {
      name: "/model",
      description: "Choose or set the model for the current provider session.",
    },
    {
      name: "/status",
      description: "Show the current provider, model, and session status.",
    },
    {
      name: "/clear",
      description: "Clear the current transcript and activity feed.",
    },
    {
      name: "/help",
      description: "Show available slash commands.",
    },
  ];
}

export function normalizeModelInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.toLowerCase() === "default" ? undefined : trimmed;
}

export function getInteractionMode(
  permissionMode: AdapterPermissionMode,
  runMode: AdapterRunMode,
): InteractionModeOption {
  return INTERACTION_MODE_OPTIONS.find((mode) =>
    mode.permissionMode === permissionMode && mode.runMode === runMode)
    ?? {
      label: `${permissionMode} · ${runMode}`,
      permissionMode,
      runMode,
    };
}

export function getNextInteractionMode(
  permissionMode: AdapterPermissionMode,
  runMode: AdapterRunMode,
): InteractionModeOption {
  const currentIndex = INTERACTION_MODE_OPTIONS.findIndex((mode) =>
    mode.permissionMode === permissionMode && mode.runMode === runMode);

  if (currentIndex < 0) {
    return INTERACTION_MODE_OPTIONS[0]!;
  }

  return INTERACTION_MODE_OPTIONS[(currentIndex + 1) % INTERACTION_MODE_OPTIONS.length]!;
}

export function createQuestionUiState(request: QuestionRequest): QuestionUiState {
  return {
    activeTab: 0,
    activeRowByQuestion: request.questions.map(() => 0),
    drafts: request.questions.map(() => ({
      selectedOptionIndexes: [],
      customSelected: false,
      customValue: "",
      customCursor: 0,
    })),
  };
}

export function getQuestionRowCount(question: QuestionRequest["questions"][number]): number {
  return question.options.length + (question.allowCustom === false ? 0 : 1);
}

export function isCustomQuestionRow(
  question: QuestionRequest["questions"][number],
  rowIndex: number,
): boolean {
  return question.allowCustom !== false && rowIndex === question.options.length;
}

export function isQuestionAnswered(
  question: QuestionRequest["questions"][number],
  draft: QuestionDraftState,
): boolean {
  if (draft.selectedOptionIndexes.length > 0) {
    return true;
  }

  return question.allowCustom !== false
    && draft.customSelected
    && draft.customValue.trim().length > 0;
}

export function buildQuestionAnswerValue(
  question: QuestionRequest["questions"][number],
  draft: QuestionDraftState,
): string | string[] {
  const selectedLabels = draft.selectedOptionIndexes
    .map((index) => question.options[index]?.label)
    .filter((value): value is string => Boolean(value));
  const customValue = draft.customSelected ? draft.customValue.trim() : "";

  if (question.multiSelect) {
    return [
      ...selectedLabels,
      ...(customValue ? [customValue] : []),
    ];
  }

  if (customValue) {
    return customValue;
  }

  return selectedLabels[0] ?? "";
}

export function getQuestionSummaries(
  request: QuestionRequest,
  drafts: QuestionDraftState[],
): string[] {
  return request.questions.map((question, index) => {
    const draft = drafts[index];
    if (!draft || !isQuestionAnswered(question, draft)) {
      return "Not answered";
    }

    const value = buildQuestionAnswerValue(question, draft);
    return Array.isArray(value) ? value.join(", ") : value;
  });
}

export function isPrintableInput(input: string, key: {
  ctrl?: boolean;
  meta?: boolean;
  super?: boolean;
}): boolean {
  if (!input) {
    return false;
  }

  if (key.ctrl || key.meta || key.super) {
    return false;
  }

  return !/[\u0000-\u001F\u007F]/.test(input);
}

export function getVisibleBufferLines(buffer: TextBufferState): string[] {
  return buffer.value ? buffer.value.split("\n") : [];
}
