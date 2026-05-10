import { getAdapter, listAdapters, registerBuiltinAdapters, type AdapterEvent, type AdapterPermissionMode, type AdapterProvider, type AdapterQuestionMode, type AdapterRunMode, type AdapterSession, type AdapterSessionConfig, type PermissionDecision, type PermissionRequest, type QuestionAnswer, type QuestionRequest } from "./adapters/index.js";
import { Box, render, Text, useApp, useStdout } from "ink";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadTeamProject, parseTeamConfig } from "./team/runtime.js";
import {
  listTeamDefinitions,
  loadTeamDefinition,
  resolveGlobalTeamsDirectory,
  resolveProjectContextPath,
  resolveProjectTeamConfigPath,
  saveTeamDefinition,
} from "./team/storage.js";
import {
  ActivityView,
  CommandPalette,
  DocumentWorkflowPanel,
  Header,
  MessageView,
  ModelPickerModal,
  PromptEditor,
  PromptModal,
  QuestionModal,
  SessionPickerModal,
  ThinkingIndicator,
} from "./tui/components.js";
import {
  looksLikeNarrativeDocumentSummary,
  looksLikeStructuredDocumentDraft,
  normalizeDocumentDraft,
  setRolesMemberModel,
  setRolesProviderModel,
  summarizeRolesMemberModels,
  summarizeRolesModels,
} from "./tui/documents.js";
import {
  createBufferState,
  getEditedBuffer,
  insertIntoBuffer,
  isEnterKey,
  isEscapeKey,
  isShiftTabKey,
  isTabKey,
  useTerminalKeypress,
  type TerminalKey,
  type TextBufferState,
} from "./tui/input.js";
import type {
  ActivityStatus,
  FeedEntry,
  MessageRole,
  ModelPickerOption,
  ModelPickerState,
  PermissionPromptState,
  QuestionPromptState,
  QuestionUiState,
  SavedSession,
  SessionPickerState,
  TuiOptions,
  TuiAction,
  TuiResult,
  ToolMeta,
  UiActivity,
  UiMessage,
} from "./tui/types.js";
import {
  asNumber,
  asRecord,
  asString,
  buildQuestionAnswerValue,
  buildSlashCommands,
  buildWelcomeMessage,
  createQuestionUiState,
  findMessageIndexById,
  firstLine,
  formatCurrentModel,
  formatDuration,
  formatTokens,
  getDefaultModelLabel,
  getInteractionMode,
  getNextInteractionMode,
  getQuestionRowCount,
  hashColor,
  isCustomQuestionRow,
  isQuestionAnswered,
  normalizeModelInput,
  pushDetail,
  summarizeGenericValue,
  summarizeLabeledPaths,
  summarizePaths,
  truncate,
} from "./tui/utils.js";

function summarizeClaudeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `Bash(${truncate(asString(input.description) ?? asString(input.command) ?? "command", 90)})`;
    case "Glob":
      return `Glob(${truncate(asString(input.pattern) ?? "*", 80)})`;
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

function extractClaudeToolText(value: unknown): string | undefined {
  const record = asRecord(value);
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

function summarizeClaudeToolResult(
  tool: ToolMeta | undefined,
  rawResult: unknown,
  fallbackText: string | undefined,
): { detail?: string; stats?: string; status: ActivityStatus } {
  const record = asRecord(rawResult);

  if (tool?.name === "Agent") {
    const statusText = asString(record?.status) ?? "completed";
    const status: ActivityStatus = statusText === "completed"
      ? "done"
      : (statusText === "failed" ? "failed" : "waiting");
    const agentType = asString(record?.agentType) ?? tool.subagentType ?? "Task";
    const duration = formatDuration(asNumber(record?.totalDurationMs));
    const toolUses = asNumber(record?.totalToolUseCount);
    const tokens = asNumber(record?.totalTokens);
    const statsParts = [
      status === "done" ? "Done" : statusText,
      toolUses != null ? `${toolUses} tool uses` : undefined,
      tokens != null ? `${(tokens / 1000).toFixed(1)}k tokens` : undefined,
      duration || undefined,
    ].filter(Boolean);

    const detailText = extractClaudeToolText(record) ?? fallbackText;
    return {
      status,
      stats: statsParts.join(" · "),
      detail: detailText ? `${agentType}: ${truncate(firstLine(detailText) ?? detailText, 150)}` : undefined,
    };
  }

  if (Array.isArray(record?.filenames)) {
    const count = asNumber(record?.numFiles) ?? record.filenames.length;
    const truncatedResult = record?.truncated === true ? " (truncated)" : "";
    return {
      status: "done",
      detail: `Found ${count} files${truncatedResult}`,
    };
  }

  const fileRecord = asRecord(record?.file);
  if (fileRecord) {
    const path = asString(fileRecord.filePath);
    const lines = asNumber(fileRecord.numLines);
    return {
      status: "done",
      detail: path ? `Read ${basename(path)}${lines ? ` (${lines} lines)` : ""}` : "Read file",
    };
  }

  const filePath = asString(record?.filePath);
  if (filePath) {
    return {
      status: "done",
      detail: `${tool?.name === "Write" ? "Wrote" : "Updated"} ${basename(filePath)}`,
    };
  }

  const stdout = asString(record?.stdout);
  const stderr = asString(record?.stderr);
  const first = firstLine(stdout) ?? firstLine(stderr) ?? firstLine(fallbackText);
  return {
    status: "done",
    detail: first ? truncate(first, 150) : `${tool?.name ?? "Tool"} completed`,
  };
}

function extractTaggedText(text: string, tag: string): string | undefined {
  const match = text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
  return match?.[1]?.trim() || undefined;
}

function extractOpenCodePath(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    return extractTaggedText(value, "path")
      ?? value.match(/"filePath"\s*:\s*"([^"]+)"/)?.[1]
      ?? value.match(/"path"\s*:\s*"([^"]+)"/)?.[1];
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractOpenCodePath(entry, depth + 1);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const directPath = asString(record.filePath) ?? asString(record.path);
  if (directPath) {
    return directPath;
  }

  for (const key of ["file", "input", "output", "result", "data", "metadata", "context"]) {
    const nested = extractOpenCodePath(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function summarizeOpenCodeToolState(
  tool: string,
  state: Record<string, unknown> | undefined,
): { detail: string; status: ActivityStatus } {
  const statusText = asString(state?.status) ?? "running";
  const status: ActivityStatus = statusText === "completed"
    ? "done"
    : ((statusText === "error" || statusText === "failed") ? "failed" : "running");
  const path = extractOpenCodePath(state?.output) ?? extractOpenCodePath(state?.input) ?? extractOpenCodePath(state);
  const toolName = tool.toLowerCase();
  const input = asRecord(state?.input);
  const output = asRecord(state?.output);
  const inputDescription = asString(input?.description);
  const inputPrompt = asString(input?.prompt);

  const withPath = (
    inProgressLabel: string,
    doneLabel: string,
    fallbackInProgress: string,
    fallbackDone: string,
  ) => path
    ? `${status === "done" ? doneLabel : inProgressLabel} ${basename(path)}`
    : (status === "done" ? fallbackDone : fallbackInProgress);

  switch (toolName) {
    case "read":
      return { status, detail: withPath("Reading", "Read", "Reading file", "Read file") };
    case "write":
      return { status, detail: withPath("Writing", "Wrote", "Writing file", "Wrote file") };
    case "edit":
    case "patch":
    case "replace":
      return { status, detail: withPath("Updating", "Updated", "Updating file", "Updated file") };
    case "delete":
    case "remove":
      return { status, detail: withPath("Deleting", "Deleted", "Deleting file", "Deleted file") };
    case "task":
      return {
        status,
        detail: truncate(
          inputDescription
            ?? firstLine(inputPrompt)
            ?? (status === "done" ? "Task completed" : "Dispatching task"),
          150,
        ),
      };
    default: {
      const error = asRecord(state?.error);
      const generic = summarizeGenericValue(state?.error ?? state?.output ?? state?.input);
      const detail = firstLine(asString(error?.message))
        ?? firstLine(asString(output?.message))
        ?? inputDescription
        ?? firstLine(inputPrompt)
        ?? (path ? `${tool} ${basename(path)}` : undefined)
        ?? (generic === "{}" || generic === "[]" || generic === "no details"
          ? `${tool} ${status === "done" ? "completed" : "running"}`
          : generic);
      return {
        status,
        detail: truncate(detail, 150),
      };
    }
  }
}

function getModeColor(permissionMode: AdapterPermissionMode, runMode: AdapterRunMode): string {
  if (runMode === "plan") {
    return "yellow";
  }
  if (permissionMode === "auto") {
    return "green";
  }
  return "cyan";
}

function isProvider(value: string | undefined): value is AdapterProvider {
  return value === "claudeCode" || value === "codex" || value === "opencode";
}

const BUILTIN_PROVIDERS: AdapterProvider[] = ["claudeCode", "codex", "opencode"];

const DOCUMENT_STAGE_DEFINITIONS = [
  {
    key: "goal",
    fileName: "goal.md",
    description: "Capture the product goal, target user, problem, and success outcome.",
    requirements: [
      "Use markdown headings and concise paragraphs.",
      "Explain what is being built, for whom, and why it matters.",
      "Call out constraints, non-goals, or success signals when useful.",
    ],
  },
  {
    key: "plan",
    fileName: "plan.md",
    description: "Break the work into implementation phases and decision points.",
    requirements: [
      "Organize the work into clear phases or milestones.",
      "Describe sequence, dependencies, and what gets delivered in each phase.",
      "Keep it implementation-oriented rather than aspirational.",
    ],
  },
  {
    key: "spec",
    fileName: "spec.md",
    description: "Describe the behavior, architecture, constraints, and UX/runtime expectations.",
    requirements: [
      "Document the important behavior, flows, and system constraints.",
      "Cover interfaces, data expectations, and user-visible behavior.",
      "Keep it specific enough that tasks can be derived from it.",
    ],
  },
  {
    key: "tasks",
    fileName: "tasks.md",
    description: "Turn the plan and spec into an actionable checklist.",
    requirements: [
      "Return markdown checklist items using exactly `- [ ] ...` for incomplete tasks.",
      "Each task must be concrete, scoped, and directly actionable.",
      "Prefer task titles that are easy to parse into stable IDs later.",
    ],
  },
  {
    key: "roles",
    fileName: "roles.json",
    description: "Define the orchestrator/coworker team configuration.",
    requirements: [
      "Return a JSON object because the runtime reads roles.json directly.",
      "The JSON object must define orchestrator, coworkers, and runtime.",
      "Use the shape { orchestrator, coworkers, runtime } and include at least one coworker.",
      "Every orchestrator and coworker must include exactly these member keys: name, description, provider, model.",
      "Every orchestrator and coworker must include a valid provider: claudeCode, codex, or opencode.",
      "Every orchestrator and coworker must include an explicit model string from a real provider model value.",
      "Do not include expertise, capabilities, role, cwd, systemPrompt, id, or any other extra member fields.",
      "Prefer runtime keys maxIdleTurns, stopWhenTasksComplete, and maxConcurrentAgents.",
      "Do not add markdown fences, headings, or prose outside the JSON object.",
    ],
  },
] as const;

type DocumentStageKey = typeof DOCUMENT_STAGE_DEFINITIONS[number]["key"];

interface DocumentStageDraft {
  key: DocumentStageKey;
  fileName: string;
  path: string;
  approved: boolean;
  draft?: string;
}

interface DocumentWorkflowState {
  stages: DocumentStageDraft[];
  currentIndex: number;
  lastSavedPath?: string;
}

interface RolesDocumentPromptHints {
  defaultProvider: AdapterProvider;
  providers: Array<{
    provider: AdapterProvider;
    preferredModel?: string;
    allowedModels: string[];
  }>;
}

function createDocumentWorkflowState(cwd: string): DocumentWorkflowState {
  return {
    currentIndex: 0,
    lastSavedPath: undefined,
    stages: DOCUMENT_STAGE_DEFINITIONS.map((stage) => ({
      key: stage.key,
      fileName: stage.fileName,
      path: resolveProjectContextPath(cwd, stage.fileName),
      approved: false,
      draft: undefined,
    })),
  };
}

function getCurrentDocumentStage(
  workflow: DocumentWorkflowState,
): DocumentStageDraft | undefined {
  return workflow.currentIndex < workflow.stages.length
    ? workflow.stages[workflow.currentIndex]
    : undefined;
}

function getDocumentStageDefinition(key: DocumentStageKey) {
  return DOCUMENT_STAGE_DEFINITIONS.find((stage) => stage.key === key)!;
}

function filterModelOptions(options: ModelPickerOption[], filter: string): ModelPickerOption[] {
  if (!filter) return options;
  const lower = filter.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(lower) || (o.value ?? "").toLowerCase().includes(lower));
}

function formatSessionTime(timestamp: string): string {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) return timestamp;
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function ensureTrailingNewline(text: string): string {
  return text.trimEnd() ? `${text.trimEnd()}\n` : "";
}

function buildApprovedDocumentContext(workflow: DocumentWorkflowState): string {
  const approvedStages = workflow.stages.filter((stage) => stage.approved && stage.draft?.trim());
  if (approvedStages.length === 0) {
    return "- none yet";
  }

  return approvedStages
    .map((stage) => `## ${stage.fileName}\n${stage.draft?.trim() ?? ""}`)
    .join("\n\n");
}

function buildDocumentStagePrompt(input: {
  workflow: DocumentWorkflowState;
  stage: DocumentStageDraft;
  request: string;
  autoGenerate: boolean;
  rolesHints?: RolesDocumentPromptHints;
}): string {
  const definition = getDocumentStageDefinition(input.stage.key);
  const currentDraft = input.stage.draft?.trim();

  return [
    "You are generating the project context files one file at a time.",
    "File order: .kyros/goal.md -> .kyros/plan.md -> .kyros/spec.md -> .kyros/tasks.md -> .kyros/roles.json.",
    `Current file: ${definition.fileName}.`,
    `Stage purpose: ${definition.description}`,
    "Return only the full contents of the current file.",
    definition.key === "roles"
      ? "For roles.json, return only the JSON object for the team definition."
      : "Do not add commentary before or after the file content.",
    definition.key === "roles" && input.rolesHints
      ? (() => {
        const defaultEntry = input.rolesHints.providers.find((entry) => entry.provider === input.rolesHints?.defaultProvider);
        return `Default every team member to provider=${input.rolesHints.defaultProvider}${defaultEntry?.preferredModel ? ` and model=${defaultEntry.preferredModel}` : ""} unless the approved docs explicitly require something else.`;
      })()
      : undefined,
    definition.key === "roles" && input.rolesHints && input.rolesHints.providers.length > 0
      ? "Allowed provider/model catalog:"
      : undefined,
    ...(definition.key === "roles" && input.rolesHints
      ? input.rolesHints.providers.map((entry) =>
          `- ${entry.provider}: ${entry.allowedModels.join(", ")}${entry.preferredModel ? ` (prefer ${entry.preferredModel})` : ""}`)
      : []),
    definition.key === "roles" && input.rolesHints && input.rolesHints.providers.length > 0
      ? "Use only provider/model pairs from this catalog. Never invent a model id."
      : undefined,
    "Requirements:",
    ...definition.requirements.map((item) => `- ${item}`),
    "",
    "Approved earlier files:",
    buildApprovedDocumentContext(input.workflow),
    currentDraft
      ? `\nCurrent draft of ${definition.fileName}:\n${currentDraft}`
      : undefined,
    "",
    input.autoGenerate
      ? `Draft the first complete version of ${definition.fileName} now.`
      : `User request for ${definition.fileName}:\n${input.request.trim()}`,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

function LoopsInkTui({
  options,
  onAction,
}: {
  options: TuiOptions;
  onAction: (action: TuiAction) => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout.columns || 80;
  const [currentModel, setCurrentModel] = useState<string | undefined>(options.model);
  const [currentProvider, setCurrentProvider] = useState<AdapterProvider>(options.provider);
  const currentProviderRef = useRef<AdapterProvider>(options.provider);
  const [currentPermissionMode, setCurrentPermissionMode] = useState<AdapterPermissionMode>(options.permissionMode);
  const [currentRunMode, setCurrentRunMode] = useState<AdapterRunMode>(options.runMode);
  const [messages, setMessages] = useState<UiMessage[]>([
    {
      id: "welcome",
      role: "system",
      text: buildWelcomeMessage(options.provider, options.model),
    },
  ]);
  const [feed, setFeed] = useState<FeedEntry[]>([
    { kind: "message", id: "welcome" },
  ]);
  const [activities, setActivities] = useState<UiActivity[]>([]);
  const [inputBuffer, setInputBufferState] = useState<TextBufferState>(() => createBufferState(""));
  const [sessionId, setSessionId] = useState<string>();
  const [statusLine, setStatusLine] = useState("Connecting...");
  const [usageLine, setUsageLine] = useState<string>();
  const [pendingPermission, setPendingPermission] = useState<PermissionPromptState | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionPromptState | null>(null);
  const [questionUi, setQuestionUi] = useState<QuestionUiState | null>(null);
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [errorText, setErrorText] = useState<string>();
  const [slashSelectionIndex, setSlashSelectionIndex] = useState(0);
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  const [sessionPicker, setSessionPicker] = useState<SessionPickerState | null>(null);
  const [documentWorkflow, setDocumentWorkflow] = useState<DocumentWorkflowState>(() =>
    createDocumentWorkflowState(options.cwd),
  );
  const [workflowFocus, setWorkflowFocus] = useState<"approve" | "input">("input");

  const sessionRef = useRef<AdapterSession | null>(null);
  const runningRef = useRef(false);
  const sentInitialPromptRef = useRef(false);
  const destroyedRef = useRef(false);
  const connectTokenRef = useRef(0);
  const idRef = useRef(0);
  const feedKeysRef = useRef(new Set<string>(["message:welcome"]));
  const toolMetaRef = useRef(new Map<string, ToolMeta>());
  const taskToolRef = useRef(new Map<string, string>());
  const openAssistantMessageIdRef = useRef<string | null>(null);
  const lastAssistantMessageIdRef = useRef<string | null>(null);
  const currentTurnAssistantMessageIdsRef = useRef<string[]>([]);
  const currentTurnTouchedPathsRef = useRef<Set<string>>(new Set());
  const activitiesRef = useRef<UiActivity[]>([]);
  const documentWorkflowRef = useRef(documentWorkflow);
  const activeDocumentStageKeyRef = useRef<DocumentStageKey | null>(null);
  const activeDocumentStageInitialContentRef = useRef<string | null>(null);

  const nextId = () => `id-${++idRef.current}`;
  const inputValue = inputBuffer.value;
  const interactionMode = getInteractionMode(currentPermissionMode, currentRunMode);
  const currentDocumentStage = getCurrentDocumentStage(documentWorkflow);

  function applyInputBuffer(nextBuffer: TextBufferState) {
    setInputBufferState(nextBuffer);
  }

  function updateInputBuffer(updater: (current: TextBufferState) => TextBufferState) {
    setInputBufferState((current) => updater(current));
  }

  function ensureFeedEntry(kind: FeedEntry["kind"], id: string) {
    const key = `${kind}:${id}`;
    if (feedKeysRef.current.has(key)) {
      return;
    }
    feedKeysRef.current.add(key);
    setFeed((current) => [...current, { kind, id }]);
  }

  function moveFeedEntryToEnd(kind: FeedEntry["kind"], id: string) {
    setFeed((current) => {
      const index = current.findIndex((entry) => entry.kind === kind && entry.id === id);
      if (index < 0 || index === current.length - 1) {
        return current;
      }

      const next = [...current];
      const [entry] = next.splice(index, 1);
      if (!entry) {
        return current;
      }
      next.push(entry);
      return next;
    });
  }

  function closeAssistantStream() {
    const messageId = openAssistantMessageIdRef.current;
    if (!messageId) {
      return;
    }

    openAssistantMessageIdRef.current = null;
    setMessages((current) => {
      const next = [...current];
      const messageIndex = findMessageIndexById(next, messageId);
      if (messageIndex < 0) {
        return next;
      }

      next[messageIndex] = {
        ...next[messageIndex]!,
        live: false,
      };
      return next;
    });
  }

  function appendMessage(role: MessageRole, text: string, live = false) {
    if (role !== "assistant") {
      closeAssistantStream();
    }

    const id = nextId();
    ensureFeedEntry("message", id);
    setMessages((current) => [...current, { id, role, text, live }]);

    if (role === "assistant") {
      lastAssistantMessageIdRef.current = id;
      openAssistantMessageIdRef.current = live ? id : null;
    }
  }

  function resetConversationState(nextModel: string | undefined) {
    const welcomeMessage: UiMessage = {
      id: "welcome",
      role: "system",
      text: buildWelcomeMessage(options.provider, nextModel),
    };

    feedKeysRef.current = new Set(["message:welcome"]);
    setMessages([welcomeMessage]);
    setFeed([{ kind: "message", id: "welcome" }]);
    setActivities([]);
    openAssistantMessageIdRef.current = null;
    lastAssistantMessageIdRef.current = null;
    currentTurnAssistantMessageIdsRef.current = [];
    currentTurnTouchedPathsRef.current = new Set();
    activeDocumentStageInitialContentRef.current = null;
    toolMetaRef.current.clear();
    taskToolRef.current.clear();
  }

  function updateDocumentStageDraft(stageKey: DocumentStageKey, draft: string) {
    setDocumentWorkflow((current) => ({
      ...current,
      lastSavedPath: current.stages.find((stage) => stage.key === stageKey)?.path,
      stages: current.stages.map((stage) =>
        stage.key === stageKey
          ? { ...stage, draft }
          : stage),
    }));
  }

  function isOpenCodeDocumentStageRun() {
    return options.provider === "opencode" && activeDocumentStageKeyRef.current !== null;
  }

  function normalizeTrackedPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) {
      return "";
    }

    if (trimmed.startsWith("/")) {
      return resolve(trimmed);
    }

    const cwdBase = basename(options.cwd);
    if (trimmed === cwdBase || trimmed.startsWith(`${cwdBase}/`)) {
      return resolve(options.cwd, "..", trimmed);
    }

    return resolve(options.cwd, trimmed);
  }

  function trackTouchedPath(path: string | undefined) {
    if (!path) {
      return;
    }

    const normalized = normalizeTrackedPath(path);
    if (normalized) {
      currentTurnTouchedPathsRef.current.add(normalized);
    }
  }

  function showDocumentDraft(draft: string) {
    if (!draft.trim()) {
      return;
    }

    const targetMessageId = lastAssistantMessageIdRef.current ?? openAssistantMessageIdRef.current;
    if (targetMessageId) {
      replaceLastAssistantMessage(draft);
      return;
    }

    syncAssistantMessage(draft, true);
  }

  async function loadChangedDocumentDraftFromDisk(
    stageKey: DocumentStageKey,
    stagePath: string,
    initialContent: string | null,
    validation: { requireModels?: boolean; requireDescriptions?: boolean },
    allowUnchanged = false,
  ): Promise<string | null> {
    try {
      const existing = await readFile(stagePath, "utf8");
      const diskChanged = initialContent === null
        ? existing.trim().length > 0
        : existing !== initialContent;

      if (!diskChanged && !allowUnchanged) {
        return null;
      }

      const normalized = normalizeDocumentDraft(
        stageKey,
        existing,
        options.cwd,
        options.provider,
        validation,
      );

      if (!normalized) {
        return null;
      }

      if (stageKey !== "roles" && !looksLikeStructuredDocumentDraft(stageKey, normalized)) {
        return null;
      }

      return normalized;
    } catch {
      return null;
    }
  }

  async function persistCompletedDocumentDraft(text: string) {
    const stageKey = activeDocumentStageKeyRef.current;
    activeDocumentStageKeyRef.current = null;
    if (!stageKey) {
      return;
    }

    const workflow = documentWorkflowRef.current;
    const stage = workflow.stages.find((entry) => entry.key === stageKey);
    if (!stage) {
      activeDocumentStageInitialContentRef.current = null;
      return;
    }

    const initialContent = activeDocumentStageInitialContentRef.current;
    activeDocumentStageInitialContentRef.current = null;
    const validation = {
      requireModels: stageKey === "roles",
      requireDescriptions: stageKey === "roles",
    };
    const stageWasTouchedThisTurn = currentTurnTouchedPathsRef.current.has(resolve(stage.path));
    let draft = "";
    const diskDraft = options.provider === "opencode"
      ? await loadChangedDocumentDraftFromDisk(
        stageKey,
        stage.path,
        initialContent,
        validation,
        stageWasTouchedThisTurn,
      )
      : null;

    if (diskDraft) {
      draft = diskDraft;
    } else {
      try {
        draft = normalizeDocumentDraft(stageKey, text, options.cwd, options.provider, validation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendMessage("system", `Failed to save ${stage.fileName}: ${message}`);
        setStatusLine(`Invalid ${stage.fileName} draft`);
        return;
      }
    }

    if (!draft) {
      setStatusLine(`No ${stage.fileName} draft was returned.`);
      return;
    }

    if (stageKey !== "roles" && !diskDraft) {
      const responseLooksNarrative =
        looksLikeNarrativeDocumentSummary(draft)
        || !looksLikeStructuredDocumentDraft(stageKey, draft);

      if (responseLooksNarrative) {
        const recoveredDraft = await loadChangedDocumentDraftFromDisk(
          stageKey,
          stage.path,
          initialContent,
          validation,
          stageWasTouchedThisTurn,
        );

        if (recoveredDraft) {
          draft = recoveredDraft;
        } else {
          appendMessage(
            "system",
            `Failed to save ${stage.fileName}: provider returned a narrative summary instead of the file contents.`,
          );
          setStatusLine(`Invalid ${stage.fileName} draft`);
          return;
        }
      }
    }

    if (stageKey === "roles") {
      try {
        await validateRolesMemberModels(draft);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendMessage("system", `Failed to save ${stage.fileName}: ${message}`);
        setStatusLine(`Invalid ${stage.fileName} draft`);
        return;
      }
    }

    try {
      await mkdir(dirname(stage.path), { recursive: true });
      await writeFile(stage.path, ensureTrailingNewline(draft), "utf8");
      updateDocumentStageDraft(stageKey, draft);
      if (options.provider === "opencode") {
        showDocumentDraft(draft);
      }
      setWorkflowFocus("approve");
      setStatusLine(`Drafted ${stage.fileName}. Approve or refine it.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Failed to save ${stage.fileName}: ${message}`);
      setStatusLine(`Failed to save ${stage.fileName}`);
    }
  }

  async function runPrompt(
    sendText: string,
    display?: { role: MessageRole; text: string },
  ) {
    const trimmed = sendText.trim();
    if (!trimmed || !sessionRef.current || runningRef.current) {
      return;
    }

    if (display?.text.trim()) {
      appendMessage(display.role, display.text.trim());
    }

    applyInputBuffer(createBufferState(""));
    setRunning(true);
    runningRef.current = true;
    currentTurnAssistantMessageIdsRef.current = [];
    currentTurnTouchedPathsRef.current = new Set();
    setStatusLine("Running...");
    setErrorText(undefined);

    try {
      await sessionRef.current.send(trimmed);
      for await (const event of sessionRef.current.stream()) {
        if (destroyedRef.current) {
          break;
        }
        handleAdapterEvent(event);
      }
    } catch (error) {
      activeDocumentStageKeyRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Error: ${message}`);
      setErrorText(message);
      setStatusLine("Error");
      setRunning(false);
      runningRef.current = false;
    }
  }

  async function submitDocumentStageRequest(
    stageKey: DocumentStageKey,
    request: string,
    autoGenerate = false,
  ) {
    const workflow = documentWorkflowRef.current;
    const stage = workflow.stages.find((entry) => entry.key === stageKey);
    if (!stage) {
      return;
    }

    let rolesHints: RolesDocumentPromptHints | undefined;
    try {
      rolesHints = stageKey === "roles"
        ? await resolveRolesPromptHints()
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Unable to prepare ${stage.fileName}: ${message}`);
      setStatusLine(`Cannot generate ${stage.fileName}`);
      return;
    }

    const prompt = buildDocumentStagePrompt({
      workflow,
      stage,
      request,
      autoGenerate,
      rolesHints,
    });

    activeDocumentStageKeyRef.current = stageKey;
    try {
      activeDocumentStageInitialContentRef.current = await readFile(stage.path, "utf8");
    } catch {
      activeDocumentStageInitialContentRef.current = null;
    }

    if (autoGenerate) {
      appendMessage("system", `Generating ${stage.fileName} from the approved docs.`);
      await runPrompt(prompt);
      return;
    }

    await runPrompt(prompt, { role: "user", text: request });
  }

  async function resolveRolesPromptHints(): Promise<RolesDocumentPromptHints> {
    const providerResults = await Promise.all(
      BUILTIN_PROVIDERS.map(async (provider) => {
        try {
          const listedModels = await getAdapter(provider).listModels?.({ cwd: options.cwd });
          const allowedModels = [...new Set(
            (listedModels ?? [])
              .flatMap((option) => (typeof option.value === "string" && option.value.trim()
                ? [option.value.trim()]
                : [])),
          )];

          return {
            provider,
            allowedModels,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to load ${provider} models: ${message}`);
        }
      }),
    );

    const providers = providerResults
      .filter((entry) => entry.allowedModels.length > 0)
      .map((entry) => ({
        provider: entry.provider,
        preferredModel: entry.provider === options.provider
          ? (() => {
            const current = currentModel?.trim() ? currentModel.trim() : undefined;
            return current && entry.allowedModels.includes(current)
              ? current
              : entry.allowedModels[0];
          })()
          : entry.allowedModels[0],
        allowedModels: entry.allowedModels,
      }));

    if (providers.length === 0) {
      throw new Error("No provider models were returned.");
    }

    return {
      defaultProvider: options.provider,
      providers,
    };
  }

  async function validateRolesMemberModels(content: string): Promise<void> {
    const members = summarizeRolesMemberModels(content, options.cwd, options.provider);
    const grouped = new Map<AdapterProvider, Set<string>>();

    for (const member of members) {
      if (!member.model?.trim()) {
        continue;
      }

      const bucket = grouped.get(member.provider) ?? new Set<string>();
      bucket.add(member.model.trim());
      grouped.set(member.provider, bucket);
    }

    for (const [provider, models] of grouped.entries()) {
      const listedModels = await getAdapter(provider).listModels?.({ cwd: options.cwd });
      const allowed = new Set(
        (listedModels ?? [])
          .flatMap((option) => (typeof option.value === "string" && option.value.trim()
            ? [option.value.trim()]
            : [])),
      );

      if (allowed.size === 0) {
        throw new Error(`Unable to validate ${provider} models because the provider did not return any models.`);
      }

      for (const model of models) {
        if (!allowed.has(model)) {
          throw new Error(
            `Unknown ${provider} model "${model}". Use one of: ${[...allowed].slice(0, 12).join(", ")}`,
          );
        }
      }
    }
  }

  async function approveCurrentDocumentStage() {
    if (runningRef.current) {
      return;
    }

    const workflow = documentWorkflowRef.current;
    const stage = getCurrentDocumentStage(workflow);
    if (!stage) {
      setStatusLine("All document stages are already approved.");
      return;
    }

    if (!stage.draft?.trim()) {
      setStatusLine(`Wait for a ${stage.fileName} draft before approving.`);
      return;
    }

    const nextIndex = workflow.currentIndex + 1;
    const nextStage = workflow.stages[nextIndex];

    setDocumentWorkflow((current) => ({
      ...current,
      currentIndex: nextIndex,
      lastSavedPath: stage.path,
      stages: current.stages.map((entry) =>
        entry.key === stage.key
          ? { ...entry, approved: true }
          : entry),
    }));
    setWorkflowFocus("input");

    if (!nextStage) {
      appendMessage("system", `Approved ${stage.fileName}. All project context files are ready.`);
      setStatusLine("Document workflow complete");
      return;
    }

    appendMessage("system", `Approved ${stage.fileName}. Moving to ${nextStage.fileName}.`);
    void submitDocumentStageRequest(nextStage.key, "", true);
  }

  function syncRolesStageDraft(content: string) {
    updateDocumentStageDraft("roles", content.trimEnd());
    if (getCurrentDocumentStage(documentWorkflowRef.current)?.key === "roles") {
      setWorkflowFocus("approve");
    }
  }

  async function readCurrentRolesContent(): Promise<string> {
    const rolesStage = documentWorkflowRef.current.stages.find((stage) => stage.key === "roles");
    if (rolesStage?.draft?.trim()) {
      return ensureTrailingNewline(normalizeDocumentDraft("roles", rolesStage.draft, options.cwd, options.provider));
    }

    try {
      const path = await resolveProjectTeamConfigPath(options.cwd);
      const content = await readFile(path, "utf8");
      return ensureTrailingNewline(normalizeDocumentDraft("roles", content, options.cwd, options.provider));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("No team definition is available yet. Finish roles.json first or use /team use <name>.");
      }
      throw error;
    }
  }

  async function listTeamsCommand() {
    const teams = await listTeamDefinitions(options.cwd);
    if (teams.length === 0) {
      appendMessage("system", `No saved teams yet. Use /team save <name> to save one globally in ${resolveGlobalTeamsDirectory()}.`);
      setStatusLine("No saved teams");
      return;
    }

    appendMessage(
      "system",
      [
        "Saved teams:",
        ...teams.map((team) => `- ${team.name}  ${team.scope}  ${team.path}`),
        "Use /team use <name> or /team run <name>.",
      ].join("\n"),
    );
    setStatusLine(`Found ${teams.length} saved team${teams.length === 1 ? "" : "s"}`);
  }

  async function saveNamedTeam(rawName: string) {
    const name = rawName.trim();
    if (!name) {
      appendMessage("system", "Usage: /team save <name>");
      setStatusLine("Team name required");
      return;
    }

    const content = await readCurrentRolesContent();
    parseTeamConfig(content, options.cwd, { requireModels: true, requireDescriptions: true });
    await validateRolesMemberModels(content);
    const saved = await saveTeamDefinition(options.cwd, name, content);
    syncRolesStageDraft(content);
    appendMessage("system", `Saved ${saved.scope} team ${saved.name}.\n${saved.path}`);
    setStatusLine(`Saved team ${saved.name}`);
  }

  async function useNamedTeam(rawName: string) {
    const name = rawName.trim();
    if (!name) {
      appendMessage("system", "Usage: /team use <name>");
      setStatusLine("Team name required");
      return;
    }

    const loaded = await loadTeamDefinition(options.cwd, name);
    parseTeamConfig(loaded.content, options.cwd, { requireModels: true, requireDescriptions: true });
    await validateRolesMemberModels(loaded.content);
    const targetPath = await resolveProjectTeamConfigPath(options.cwd);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, ensureTrailingNewline(loaded.content), "utf8");
    syncRolesStageDraft(loaded.content);
    appendMessage("system", `Using team ${loaded.name}. ${basename(targetPath)} updated.`);
    setStatusLine(`Using team ${loaded.name}`);
  }

  async function showTeamModels() {
    const content = await readCurrentRolesContent();
    const memberSummaries = summarizeRolesMemberModels(content, options.cwd, options.provider);
    const providerSummaries = summarizeRolesModels(content, options.cwd, options.provider);
    appendMessage(
      "system",
      [
        "Team models:",
        ...memberSummaries.map((entry) =>
          `- ${entry.id}${entry.isOrchestrator ? " [orchestrator]" : ""}: ${entry.provider} · ${entry.model ?? "default"}`,
        ),
        "",
        "Provider groups:",
        ...providerSummaries.map((entry) =>
          `- ${entry.provider}: ${entry.model ?? "default"}  (${entry.members.join(", ")})`,
        ),
        "Use /team model <member> <model>. Use /team provider-model <provider> <model>.",
      ].join("\n"),
    );
    setStatusLine("Team models");
  }

  async function setTeamMemberModel(rawMember: string, rawModel: string) {
    const member = rawMember.trim();
    if (!member) {
      appendMessage("system", "Usage: /team model <member> <model>");
      setStatusLine("Member required");
      return;
    }

    const content = await readCurrentRolesContent();
    const normalizedModel = rawModel.trim();
    if (!normalizedModel) {
      await showTeamModels();
      return;
    }

    if (normalizedModel.toLowerCase() === "default") {
      appendMessage("system", "roles.json requires an explicit model for every team member.");
      setStatusLine("Explicit model required");
      return;
    }

    const nextModel = normalizedModel;
    const result = setRolesMemberModel(content, options.cwd, options.provider, member, nextModel);
    await validateRolesMemberModels(result.content);
    const targetPath = await resolveProjectTeamConfigPath(options.cwd);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, ensureTrailingNewline(result.content), "utf8");
    syncRolesStageDraft(result.content);
    appendMessage(
      "system",
      `${result.updatedMembers.join(", ")} model ${nextModel} applied.`,
    );
    setStatusLine("Updated member model");
  }

  async function setTeamProviderModel(rawProvider: string, rawModel: string) {
    const provider = rawProvider.trim();
    if (!isProvider(provider)) {
      appendMessage("system", "Usage: /team provider-model <claudeCode|codex|opencode> <model>");
      setStatusLine("Provider required");
      return;
    }

    const content = await readCurrentRolesContent();
    const normalizedModel = rawModel.trim();
    if (!normalizedModel) {
      await showTeamModels();
      return;
    }

    if (normalizedModel.toLowerCase() === "default") {
      appendMessage("system", "roles.json requires an explicit model for every team member.");
      setStatusLine("Explicit model required");
      return;
    }

    const nextModel = normalizedModel;
    const result = setRolesProviderModel(content, options.cwd, options.provider, provider, nextModel);

    if (result.updatedMembers.length === 0) {
      appendMessage("system", `No team members use provider ${provider}.`);
      setStatusLine("No matching team members");
      return;
    }

    await validateRolesMemberModels(result.content);
    const targetPath = await resolveProjectTeamConfigPath(options.cwd);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, ensureTrailingNewline(result.content), "utf8");
    syncRolesStageDraft(result.content);
    appendMessage(
      "system",
      `${provider} model ${nextModel} applied to ${result.updatedMembers.join(", ")}.`,
    );
    setStatusLine(`Updated ${provider} model`);
  }

  async function launchTeamRun(rawName: string) {
    if (runningRef.current) {
      appendMessage("system", "Wait for the current run to finish before launching team mode.");
      return;
    }

    const teamName = rawName.trim() || undefined;

    try {
      await loadTeamProject(options.cwd, teamName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Team launch failed: ${message}`);
      setStatusLine("Team launch failed");
      return;
    }

    onAction({
      type: "run-team",
      teamName,
      model: currentModel,
      permissionMode: currentPermissionMode,
      runMode: currentRunMode,
      questionMode: options.questionMode,
    });

    try {
      await sessionRef.current?.close();
    } catch {
      // Best-effort cleanup before switching to team mode.
    }

    exit();
  }

  async function connectSession(
    modelOverride: string | undefined,
    statusMessage = "Connecting...",
    overrides?: {
      permissionMode?: AdapterPermissionMode;
      runMode?: AdapterRunMode;
    },
  ) {
    const token = ++connectTokenRef.current;
    setReady(false);
    setRunning(false);
    runningRef.current = false;
    setSessionId(undefined);
    setPendingPermission(null);
    setPendingQuestion(null);
    setUsageLine(undefined);
    setErrorText(undefined);
    setStatusLine(statusMessage);
    activeDocumentStageKeyRef.current = null;
    toolMetaRef.current.clear();
    taskToolRef.current.clear();

    const previousSession = sessionRef.current;
    sessionRef.current = null;
    if (previousSession) {
      try {
        await previousSession.close();
      } catch {
        // Best-effort close.
      }
    }

    try {
      const adapter = getAdapter(currentProviderRef.current);
      const permissionHandler = async (request: PermissionRequest) => new Promise<PermissionDecision>((resolve) => {
        setPendingPermission({ request, resolve });
      });

      const questionHandler = async (request: QuestionRequest) => new Promise<QuestionAnswer | undefined>((resolve) => {
        setPendingQuestion({ request, resolve });
      });

      const config: AdapterSessionConfig = {
        cwd: options.cwd,
        model: modelOverride,
        systemPrompt: options.systemPrompt,
        runMode: overrides?.runMode ?? currentRunMode,
        questionMode: options.questionMode,
        permissions: {
          mode: overrides?.permissionMode ?? currentPermissionMode,
        },
        onQuestion: questionHandler,
        ...((overrides?.permissionMode ?? currentPermissionMode) === "interactive"
          ? { onPermissionRequest: permissionHandler }
          : {}),
      };

      const session = await adapter.createSession(config);
      if (destroyedRef.current || token !== connectTokenRef.current) {
        await session.close();
        return;
      }

      sessionRef.current = session;
      setReady(true);
      setStatusLine("Ready");
    } catch (error) {
      if (token !== connectTokenRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Failed to start session: ${message}`);
      setErrorText(message);
      setStatusLine("Startup failed");
    }
  }

  function appendAssistantDelta(delta: string) {
    if (!delta) {
      return;
    }

    let targetMessageId = openAssistantMessageIdRef.current;
    if (!targetMessageId) {
      targetMessageId = nextId();
      ensureFeedEntry("message", targetMessageId);
      lastAssistantMessageIdRef.current = targetMessageId;
      openAssistantMessageIdRef.current = targetMessageId;
      currentTurnAssistantMessageIdsRef.current.push(targetMessageId);
    }

    setMessages((current) => {
      const next = [...current];
      const messageIndex = findMessageIndexById(next, targetMessageId);
      if (messageIndex >= 0) {
        next[messageIndex] = {
          ...next[messageIndex]!,
          text: `${next[messageIndex]!.text}${delta}`,
          live: true,
        };
        return next;
      }

      next.push({ id: targetMessageId, role: "assistant", text: delta, live: true });
      return next;
    });

    if (options.provider === "opencode") {
      moveFeedEntryToEnd("message", targetMessageId);
    }
  }

  function finalizeAssistantTurn(text: string) {
    const messageIds = currentTurnAssistantMessageIdsRef.current.filter(Boolean);
    currentTurnAssistantMessageIdsRef.current = [];

    if (messageIds.length <= 1) {
      syncAssistantMessage(text, true);
      const targetMessageId = lastAssistantMessageIdRef.current;
      if (options.provider === "opencode" && targetMessageId) {
        moveFeedEntryToEnd("message", targetMessageId);
      }
      return;
    }

    const primaryId = messageIds[0]!;
    const duplicateIds = new Set(messageIds.slice(1));
    openAssistantMessageIdRef.current = null;
    lastAssistantMessageIdRef.current = primaryId;

    setMessages((current) => {
      const next: UiMessage[] = [];
      for (const message of current) {
        if (!messageIds.includes(message.id)) {
          next.push(message);
          continue;
        }

        if (message.id !== primaryId) {
          continue;
        }

        next.push({
          ...message,
          text: text || message.text,
          live: false,
        });
      }
      return next;
    });

    if (duplicateIds.size > 0) {
      for (const id of duplicateIds) {
        feedKeysRef.current.delete(`message:${id}`);
      }
      setFeed((current) => current.filter((entry) => !(entry.kind === "message" && duplicateIds.has(entry.id))));
    }

    if (options.provider === "opencode") {
      moveFeedEntryToEnd("message", primaryId);
    }
  }

  function syncAssistantMessage(text: string, finalize = false) {
    const targetMessageId =
      openAssistantMessageIdRef.current
      ?? lastAssistantMessageIdRef.current;

    setMessages((current) => {
      const next = [...current];

      if (targetMessageId) {
        const messageIndex = findMessageIndexById(next, targetMessageId);
        if (messageIndex >= 0) {
          const previous = next[messageIndex]!;
          next[messageIndex] = {
          ...previous,
          text: text && text.length >= previous.text.length ? text : previous.text,
          live: openAssistantMessageIdRef.current === targetMessageId && !finalize,
          };
          return next;
        }
      }

      if (!text) {
        return next;
      }

      const id = nextId();
      ensureFeedEntry("message", id);
      lastAssistantMessageIdRef.current = id;
      openAssistantMessageIdRef.current = finalize ? null : id;
      next.push({ id, role: "assistant", text, live: !finalize });
      return next;
    });

    if (finalize) {
      openAssistantMessageIdRef.current = null;
    }

    if (options.provider === "opencode") {
      const id = targetMessageId ?? lastAssistantMessageIdRef.current;
      if (id) {
        moveFeedEntryToEnd("message", id);
      }
    }
  }

  function replaceLastAssistantMessage(text: string) {
    const targetMessageId = lastAssistantMessageIdRef.current ?? openAssistantMessageIdRef.current;
    if (!targetMessageId) {
      return;
    }

    openAssistantMessageIdRef.current = null;
    setMessages((current) => {
      const next = [...current];
      const messageIndex = findMessageIndexById(next, targetMessageId);
      if (messageIndex < 0) {
        return next;
      }

      next[messageIndex] = {
        ...next[messageIndex]!,
        text,
        live: false,
      };
      return next;
    });

    if (options.provider === "opencode") {
      moveFeedEntryToEnd("message", targetMessageId);
    }
  }

  function upsertActivity(id: string, updater: (previous: UiActivity | undefined) => UiActivity) {
    const isNewActivity = !activitiesRef.current.some((entry) => entry.id === id);
    if (isNewActivity && options.provider !== "opencode") {
      closeAssistantStream();
    }

    setActivities((current) => {
      const next = [...current];
      const index = next.findIndex((entry) => entry.id === id);
      const previous = index >= 0 ? next[index] : undefined;
      const updated = updater(previous);
      if (index >= 0) {
        next[index] = updated;
      } else {
        next.push(updated);
        ensureFeedEntry("activity", id);
      }
      activitiesRef.current = next;
      return next;
    });

    if (options.provider === "opencode") {
      const openMessageId = openAssistantMessageIdRef.current;
      if (openMessageId) {
        moveFeedEntryToEnd("message", openMessageId);
      }
    }
  }

  function pushActivityDetail(id: string, detail: string, maxDetails = 4) {
    upsertActivity(id, (previous) => {
      const details = pushDetail(previous?.details ?? [], detail, maxDetails);
      return {
        id,
        title: previous?.title ?? id,
        subtitle: previous?.subtitle,
        status: previous?.status ?? "running",
        stats: previous?.stats,
        accent: previous?.accent ?? "cyan",
        details,
        updatedAt: Date.now(),
      };
    });
  }

  function formatUsage(event: Extract<AdapterEvent, { type: "completed" }>): string {
    const { usage } = event.result;
    const parts = [
      `input=${usage.inputTokens}`,
      `output=${usage.outputTokens}`,
      usage.costUsd != null ? `cost=$${usage.costUsd.toFixed(4)}` : undefined,
    ].filter(Boolean);

    return parts.join(" ");
  }

  async function applyModelChange(nextModel: string | undefined, label?: string, nextProvider?: AdapterProvider) {
    if (runningRef.current) {
      appendMessage("system", "Wait for the current run to finish before switching models.");
      return;
    }

    const normalized = nextModel?.trim() ? nextModel.trim() : undefined;
    const current = currentModel?.trim() ? currentModel.trim() : undefined;
    const providerChanged = nextProvider && nextProvider !== currentProviderRef.current;
    if (normalized === current && !providerChanged) {
      setModelPicker(null);
      applyInputBuffer(createBufferState(""));
      setStatusLine(`Already using ${formatCurrentModel(currentProviderRef.current, normalized)}.`);
      return;
    }

    if (nextProvider) {
      currentProviderRef.current = nextProvider;
      setCurrentProvider(nextProvider);
    }

    const displayName = label ?? formatCurrentModel(currentProviderRef.current, normalized);
    setCurrentModel(normalized);
    setModelPicker(null);
    applyInputBuffer(createBufferState(""));
    await connectSession(normalized, `Switching to ${displayName}...`);
  }

  const modelsCachePath = resolve(options.cwd, ".kyros", "models-cache.json");

  function buildModelOptions(
    providerModels: { provider: string; models: { value?: string; label: string; description: string; group?: string }[] }[],
  ): ModelPickerOption[] {
    const optionsList: ModelPickerOption[] = [];
    for (const { provider, models } of providerModels) {
      const isCurrentProvider = provider === currentProviderRef.current;
      for (const [index, model] of models.entries()) {
        const modelLabel = model.label || model.value || "default";
        optionsList.push({
          ...model,
          key: `${provider}:${model.value ?? "default"}:${index}`,
          label: `${provider}: ${modelLabel}`,
          provider,
          isCurrent: isCurrentProvider && (model.value ?? undefined) === (currentModel ?? undefined),
        });
      }
    }
    optionsList.push({
      key: "custom",
      label: "Custom model",
      description: "Enter any provider/model string manually.",
      isCurrent: false,
      isCustom: true,
    });
    return optionsList;
  }

  async function openModelPicker() {
    if (runningRef.current) {
      appendMessage("system", "Wait for the current run to finish before opening the model picker.");
      return;
    }

    applyInputBuffer(createBufferState(""));
    setModelPicker({
      options: [],
      selectedIndex: 0,
      loading: true,
      customMode: false,
      filter: "",
    });

    // Try loading from cache unless --refresh-models was passed
    if (!options.refreshModels) {
      try {
        const raw = await readFile(modelsCachePath, "utf8");
        const cached = JSON.parse(raw) as { providers: { provider: string; models: { value?: string; label: string; description: string; group?: string }[] }[] };
        if (cached?.providers?.length) {
          const optionsList = buildModelOptions(cached.providers);
          const selectedIndex = Math.max(0, optionsList.findIndex((o) => o.isCurrent));
          setModelPicker({ options: optionsList, selectedIndex, loading: false, customMode: false, filter: "" });
          setStatusLine("Select a model. (cached)");
          return;
        }
      } catch {
        // No cache or invalid — fall through to fetch
      }
    }

    setStatusLine("Loading models from all providers...");

    try {
      const allProviders = listAdapters();
      const sortedProviders = [
        options.provider,
        ...allProviders.filter((p) => p !== options.provider),
      ];

      const results = await Promise.allSettled(
        sortedProviders.map(async (provider) => {
          const adapter = getAdapter(provider);
          const models = await adapter.listModels?.({ cwd: options.cwd });
          return { provider, models: models ?? [] };
        }),
      );

      const providerModels: { provider: string; models: { value?: string; label: string; description: string; group?: string }[] }[] = [];
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        providerModels.push(result.value);
      }

      // Save cache
      try {
        await mkdir(resolve(options.cwd, ".kyros"), { recursive: true });
        await writeFile(modelsCachePath, JSON.stringify({ providers: providerModels }), "utf8");
      } catch {
        // Non-critical — ignore cache write failures
      }

      const optionsList = buildModelOptions(providerModels);
      const selectedIndex = Math.max(0, optionsList.findIndex((option) => option.isCurrent));
      setModelPicker({
        options: optionsList,
        selectedIndex,
        loading: false,
        customMode: false,
        filter: "",
      });
      setStatusLine("Select a model.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setModelPicker({
        options: [{
          key: "custom",
          label: "Custom model",
          description: "Enter a model string manually.",
          isCurrent: false,
          isCustom: true,
        }],
        selectedIndex: 0,
        loading: false,
        customMode: false,
        filter: "",
        error: `Failed to load models: ${message}`,
      });
      setStatusLine("Model picker fallback.");
    }
  }

  // Session persistence
  const sessionsDir = resolve(options.cwd, ".kyros", "sessions");
  const sessionFileIdRef = useRef<string>(`session-${Date.now()}`);

  async function saveCurrentSession() {
    const userMessages = messages.filter((m) => m.role !== "system" || m.id === "welcome");
    if (userMessages.length <= 1) return; // Only welcome message — nothing to save
    const firstUserMsg = messages.find((m) => m.role === "user");
    const summary = firstUserMsg ? firstUserMsg.text.slice(0, 120) : "Empty session";
    const session: SavedSession = {
      id: sessionFileIdRef.current,
      provider: currentProviderRef.current,
      model: currentModel,
      cwd: options.cwd,
      createdAt: sessionFileIdRef.current.replace("session-", ""),
      updatedAt: String(Date.now()),
      summary,
      messages: messages.filter((m) => m.id !== "welcome"),
    };
    try {
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(resolve(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2), "utf8");
    } catch {
      // Non-critical
    }
  }

  async function loadSessionList(): Promise<SavedSession[]> {
    try {
      const files = await readdir(sessionsDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
      const sessions: SavedSession[] = [];
      for (const file of jsonFiles.slice(0, 50)) {
        try {
          const raw = await readFile(resolve(sessionsDir, file), "utf8");
          const parsed = JSON.parse(raw) as SavedSession;
          if (parsed?.id && parsed?.messages) sessions.push(parsed);
        } catch {
          // Skip corrupt files
        }
      }
      return sessions;
    } catch {
      return [];
    }
  }

  async function openSessionPicker() {
    setSessionPicker({ sessions: [], selectedIndex: 0, loading: true, filter: "" });
    setStatusLine("Loading sessions...");
    const sessions = await loadSessionList();
    if (sessions.length === 0) {
      setSessionPicker(null);
      appendMessage("system", "No saved sessions found.");
      setStatusLine("Ready");
      return;
    }
    setSessionPicker({ sessions, selectedIndex: 0, loading: false, filter: "" });
    setStatusLine("Select a session to resume.");
  }

  function resumeSession(session: SavedSession) {
    setSessionPicker(null);
    // Restore messages and feed
    const restoredMessages: UiMessage[] = [
      { id: "welcome", role: "system", text: buildWelcomeMessage(session.provider as AdapterProvider, session.model) },
      { id: "resume-marker", role: "system", text: `── Resumed session from ${formatSessionTime(session.updatedAt)} ──` },
      ...session.messages.map((m, i) => ({ ...m, id: `resumed-${i}` })),
    ];
    setMessages(restoredMessages);
    feedKeysRef.current.clear();
    const restoredFeed: FeedEntry[] = restoredMessages.map((m) => ({ kind: "message" as const, id: m.id }));
    for (const entry of restoredFeed) feedKeysRef.current.add(`${entry.kind}:${entry.id}`);
    setFeed(restoredFeed);
    // Switch provider/model if different
    if (session.provider && session.provider !== currentProviderRef.current) {
      currentProviderRef.current = session.provider as AdapterProvider;
      setCurrentProvider(session.provider as AdapterProvider);
    }
    if (session.model !== currentModel) {
      setCurrentModel(session.model);
    }
    // Start a new session ID for continued conversation
    sessionFileIdRef.current = `session-${Date.now()}`;
    applyInputBuffer(createBufferState(""));
    void connectSession(session.model, "Resuming session...");
  }

  // Auto-save when a run completes
  const prevRunningRef = useRef(false);
  useEffect(() => {
    if (prevRunningRef.current && !running) {
      void saveCurrentSession();
    }
    prevRunningRef.current = running;
  }, [running]);

  function clearFeed() {
    resetConversationState(currentModel);
    applyInputBuffer(createBufferState(""));
    setStatusLine("Cleared.");
    setUsageLine(undefined);
    setErrorText(undefined);
  }

  async function handleSlashCommand(raw: string) {
    const trimmed = raw.trim();
    const content = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    const [commandName = "", ...rest] = content.split(/\s+/);
    const argument = rest.join(" ").trim();

    try {
      switch (commandName.toLowerCase()) {
        case "teams":
          await listTeamsCommand();
          applyInputBuffer(createBufferState(""));
          return;
        case "team": {
          const [subcommand = "", ...teamParts] = rest;
          const teamArgument = teamParts.join(" ").trim();

        switch (subcommand.toLowerCase()) {
          case "save":
            await saveNamedTeam(teamArgument);
            break;
          case "use":
            await useNamedTeam(teamArgument);
            break;
          case "run":
            await launchTeamRun(teamArgument);
            break;
          case "model": {
            const [member = "", ...modelParts] = teamParts;
            await (member
              ? setTeamMemberModel(member, modelParts.join(" "))
              : showTeamModels());
            break;
          }
          case "provider-model": {
            const [provider = "", ...modelParts] = teamParts;
            await (provider
              ? setTeamProviderModel(provider, modelParts.join(" "))
              : showTeamModels());
            break;
          }
          case "list":
          case "ls":
            await listTeamsCommand();
            break;
          default:
              appendMessage(
                "system",
                "Team commands: /teams, /team save <name>, /team use <name>, /team run [name], /team model <member> <model>, /team provider-model <provider> <model>",
              );
              setStatusLine("Team commands");
              break;
          }

          applyInputBuffer(createBufferState(""));
          return;
        }
        case "model":
          if (argument) {
            await applyModelChange(
              normalizeModelInput(argument),
              argument.toLowerCase() === "default" ? getDefaultModelLabel(options.provider) : argument,
            );
          } else {
            await openModelPicker();
          }
          return;
        case "status":
          appendMessage(
            "system",
            `provider=${currentProviderRef.current} model=${formatCurrentModel(currentProviderRef.current, currentModel)} status=${statusLine}${sessionId ? ` session=${sessionId}` : ""}`,
          );
          applyInputBuffer(createBufferState(""));
          return;
        case "clear":
          clearFeed();
          return;
        case "help":
          appendMessage(
            "system",
            "Commands: /model choose a model, /teams list saved teams, /resume continue a session, /clear reset the feed, /status show state.",
          );
          applyInputBuffer(createBufferState(""));
          return;
        case "resume":
          await openSessionPicker();
          applyInputBuffer(createBufferState(""));
          return;
        default:
          appendMessage("system", `Unknown command: /${commandName}`);
          applyInputBuffer(createBufferState(""));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendMessage("system", `Command failed: ${message}`);
      setStatusLine("Command failed");
      applyInputBuffer(createBufferState(""));
    }
  }

  async function handleSubmittedInput(value: string) {
    if (pendingPermission) {
      resolvePermission(value);
      return;
    }
    if (modelPicker) {
      if (modelPicker.loading) {
        return;
      }

      if (modelPicker.customMode) {
        const customValue = normalizeModelInput(value);
        if (!customValue) {
          setStatusLine("Enter a model value or press Esc to cancel.");
          return;
        }
        await applyModelChange(customValue, customValue);
        return;
      }

      const filtered = filterModelOptions(modelPicker.options, modelPicker.filter);
      const selected = filtered[modelPicker.selectedIndex];
      if (!selected) {
        return;
      }

      if (selected.isCustom) {
        setModelPicker((current) => current
          ? {
              ...current,
              customMode: true,
            }
          : current);
        applyInputBuffer(createBufferState(currentModel ?? ""));
        setStatusLine("Enter a custom model value.");
        return;
      }

      await applyModelChange(selected.value, selected.label, selected.provider as AdapterProvider | undefined);
      return;
    }

    if (sessionPicker) {
      return;
    }

    if (value.trim().startsWith("/")) {
      const simpleCommand = value.trim().includes(" ")
        ? value.trim()
        : (visibleSlashCommands[slashSelectionIndex]?.name ?? value.trim());
      await handleSlashCommand(simpleCommand);
      return;
    }

    const stage = getCurrentDocumentStage(documentWorkflowRef.current);
    if (stage) {
      await submitDocumentStageRequest(stage.key, value);
      return;
    }

    await submitPrompt(value);
  }

  function handleClaudeProviderEvent(data: unknown) {
    const payload = asRecord(data);
    if (!payload) {
      return;
    }

    const type = asString(payload.type);
    if (type === "assistant") {
      const message = asRecord(payload.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const entry of content) {
        const block = asRecord(entry);
        if (!block || asString(block.type) !== "tool_use") {
          continue;
        }

        const toolUseId = asString(block.id);
        const name = asString(block.name);
        const input = asRecord(block.input) ?? {};
        if (!toolUseId || !name) {
          continue;
        }

        const meta: ToolMeta = {
          id: toolUseId,
          name,
          description: asString(input.description),
          subagentType: asString(input.subagent_type),
          activityId: toolUseId,
        };
        toolMetaRef.current.set(toolUseId, meta);

        if (name === "Agent") {
          const title = meta.subagentType ?? "Task";
          upsertActivity(toolUseId, (previous) => ({
            id: toolUseId,
            title,
            subtitle: meta.description,
            status: previous?.status ?? "running",
            details: previous?.details ?? ["Initializing..."],
            stats: previous?.stats,
            accent: hashColor(title),
            updatedAt: Date.now(),
          }));
          continue;
        }

        upsertActivity(toolUseId, () => ({
          id: toolUseId,
          title: name,
          subtitle: undefined,
          status: "running",
          details: [summarizeClaudeToolUse(name, input)],
          stats: undefined,
          accent: hashColor(name),
          updatedAt: Date.now(),
        }));
      }
      return;
    }

    if (type === "user") {
      const message = asRecord(payload.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const rawToolUseResult = payload.tool_use_result;

      for (const entry of content) {
        const block = asRecord(entry);
        if (!block || asString(block.type) !== "tool_result") {
          continue;
        }

        const toolUseId = asString(block.tool_use_id);
        if (!toolUseId) {
          continue;
        }

        const meta = toolMetaRef.current.get(toolUseId);
        const fallbackText = typeof block.content === "string"
          ? block.content
          : extractClaudeToolText({ content: Array.isArray(block.content) ? block.content : [] });
        const summary = summarizeClaudeToolResult(meta, rawToolUseResult, fallbackText);

        upsertActivity(meta?.activityId ?? toolUseId, (previous) => ({
          id: meta?.activityId ?? toolUseId,
          title: previous?.title ?? meta?.name ?? "Tool",
          subtitle: previous?.subtitle,
          status: summary.status,
          details: pushDetail(previous?.details ?? [], summary.detail),
          stats: summary.stats ?? previous?.stats,
          accent: previous?.accent ?? hashColor(previous?.title ?? meta?.name ?? "Tool"),
          updatedAt: Date.now(),
        }));

        toolMetaRef.current.delete(toolUseId);
      }
      return;
    }

    if (type === "system") {
      const subtype = asString(payload.subtype);
      switch (subtype) {
        case "task_started": {
          const taskId = asString(payload.task_id);
          const toolUseId = asString(payload.tool_use_id);
          if (taskId && toolUseId) {
            taskToolRef.current.set(taskId, toolUseId);
          }
          return;
        }
        case "task_progress": {
          const taskId = asString(payload.task_id);
          const detail = asString(payload.summary) ?? asString(payload.description);
          if (!taskId || !detail) {
            return;
          }
          const toolUseId = taskToolRef.current.get(taskId);
          if (toolUseId) {
            pushActivityDetail(toolUseId, truncate(detail, 120));
          }
          return;
        }
        case "task_notification": {
          const taskId = asString(payload.task_id);
          const status = asString(payload.status);
          if (!taskId || !status) {
            return;
          }
          const toolUseId = taskToolRef.current.get(taskId);
          if (!toolUseId) {
            return;
          }

          upsertActivity(toolUseId, (previous) => ({
            id: toolUseId,
            title: previous?.title ?? "Task",
            subtitle: previous?.subtitle,
            status: status === "completed" ? "done" : (status === "failed" ? "failed" : "waiting"),
            details: previous?.details ?? [],
            stats: previous?.stats ?? [
              status === "completed" ? "Done" : status,
              asRecord(payload.usage) && asNumber(asRecord(payload.usage)?.tool_uses) != null
                ? `${asNumber(asRecord(payload.usage)?.tool_uses)} tool uses`
                : undefined,
              asRecord(payload.usage) && asNumber(asRecord(payload.usage)?.duration_ms)
                ? formatDuration(asNumber(asRecord(payload.usage)?.duration_ms))
                : undefined,
            ].filter(Boolean).join(" · "),
            accent: previous?.accent ?? hashColor(previous?.title ?? "Task"),
            updatedAt: Date.now(),
          }));
          return;
        }
        case "api_retry": {
          const attempt = asNumber(payload.attempt);
          const maxRetries = asNumber(payload.max_retries);
          const retryDelayMs = asNumber(payload.retry_delay_ms);
          const reason = asString(payload.error);
          appendMessage(
            "system",
            `Retrying${attempt && maxRetries ? ` (${attempt}/${maxRetries})` : ""}${retryDelayMs ? ` in ${Math.round(retryDelayMs)}ms` : ""}${reason ? ` due to ${reason}` : ""}`,
          );
          setStatusLine("Retrying...");
          return;
        }
        case "status": {
          const permissionMode = asString(payload.permissionMode);
          if (permissionMode) {
            setStatusLine(`Permission mode: ${permissionMode}`);
          }
          return;
        }
        default:
          return;
      }
    }
  }

  function handleCodexProviderEvent(data: unknown) {
    const payload = asRecord(data);
    if (!payload) {
      return;
    }

    const type = asString(payload.type);
    if (type === "thread.started") {
      const threadId = asString(payload.thread_id);
      if (threadId) {
        setSessionId(threadId);
      }
      return;
    }

    if (type === "turn.started") {
      setStatusLine("Thinking...");
      return;
    }

    if (type === "turn.failed") {
      const error = asRecord(payload.error);
      appendMessage("system", `Turn failed: ${asString(error?.message) ?? "Unknown error"}`);
      setStatusLine("Turn failed");
      return;
    }

    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") {
      return;
    }

    const item = asRecord(payload.item);
    const itemId = asString(item?.id);
    const itemType = asString(item?.type);
    if (!item || !itemId || !itemType) {
      return;
    }

    switch (itemType) {
      case "agent_message":
        setStatusLine(type === "item.completed" ? "Finalizing response..." : "Responding...");
        return;
      case "reasoning":
        setStatusLine("Thinking...");
        return;
      case "command_execution": {
        const status = asString(item.status);
        const command = asString(item.command) ?? "command";
        const output = firstLine(asString(item.aggregated_output));
        upsertActivity(itemId, (previous) => ({
          id: itemId,
          title: "Command",
          subtitle: truncate(command, 72),
          status: status === "completed" ? "done" : (status === "failed" ? "failed" : "running"),
          details: pushDetail(previous?.details ?? [], output ?? (status === "in_progress" ? "Running..." : "No output")),
          stats: status === "completed" || status === "failed"
            ? `exit ${asNumber(item.exit_code) ?? (status === "completed" ? 0 : 1)}`
            : "Running...",
          accent: previous?.accent ?? "yellow",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "mcp_tool_call": {
        const server = asString(item.server) ?? "mcp";
        const tool = asString(item.tool) ?? "tool";
        const status = asString(item.status);
        const result = asRecord(item.result);
        const error = asRecord(item.error);
        const detail = summarizeGenericValue(result?.structured_content ?? result ?? error ?? item.arguments);

        upsertActivity(itemId, (previous) => ({
          id: itemId,
          title: `${server}:${tool}`,
          subtitle: undefined,
          status: status === "completed" ? "done" : (status === "failed" ? "failed" : "running"),
          details: pushDetail(previous?.details ?? [], detail),
          stats: status === "completed" ? "Done" : (status === "failed" ? "Failed" : "Running..."),
          accent: previous?.accent ?? hashColor(server),
          updatedAt: Date.now(),
        }));
        return;
      }
      case "web_search": {
        const query = asString(item.query) ?? "search";
        upsertActivity(itemId, (previous) => ({
          id: itemId,
          title: "Web search",
          subtitle: truncate(query, 72),
          status: type === "item.completed" ? "done" : "running",
          details: previous?.details ?? ["Searching..."],
          stats: type === "item.completed" ? "Done" : "Running...",
          accent: previous?.accent ?? "blue",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "todo_list": {
        const items = Array.isArray(item.items)
          ? item.items.flatMap((entry) => {
              const record = asRecord(entry);
              const text = asString(record?.text);
              return text ? [{ text, completed: record?.completed === true }] : [];
            })
          : [];

        const openCount = items.filter((entry) => !entry.completed).length;
        const doneCount = items.length - openCount;
        const details = items.slice(0, 4).map((entry) => `${entry.completed ? "x" : "o"} ${truncate(entry.text, 90)}`);

        upsertActivity(itemId, (previous) => ({
          id: itemId,
          title: "Todos",
          subtitle: undefined,
          status: type === "item.completed" ? "done" : "running",
          details: details.length > 0 ? details : (previous?.details ?? ["No todos yet"]),
          stats: `${openCount} open · ${doneCount} done`,
          accent: previous?.accent ?? "green",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "file_change": {
        const changes = Array.isArray(item.changes)
          ? item.changes.flatMap((entry) => {
              const record = asRecord(entry);
              const path = asString(record?.path);
              const kind = asString(record?.kind);
              return path && kind ? [{ path, kind }] : [];
            })
          : [];

        upsertActivity(itemId, (previous) => ({
          id: itemId,
          title: "Patch",
          subtitle: undefined,
          status: asString(item.status) === "failed" ? "failed" : "done",
          details: changes.length > 0
            ? summarizeLabeledPaths(changes.map((change) => ({ label: change.kind, path: change.path })), 4)
            : (previous?.details ?? ["Updated files"]),
          stats: `${changes.length} file change(s)`,
          accent: previous?.accent ?? "cyan",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "error":
        appendMessage("system", `Codex error: ${asString(item.message) ?? "Unknown error"}`);
        return;
      default:
        return;
    }
  }

  function handleOpenCodeProviderEvent(data: unknown) {
    const payload = asRecord(data);
    if (!payload) {
      return;
    }

    const type = asString(payload.type);
    const properties = asRecord(payload.properties);
    if (!type || !properties) {
      return;
    }

    if (type === "session.created" || type === "session.updated") {
      const sessionValue = asString(properties.sessionID);
      if (sessionValue) {
        setSessionId(sessionValue);
      }
      return;
    }

    if (type === "session.error") {
      appendMessage("system", `OpenCode error: ${summarizeGenericValue(properties.error)}`);
      setStatusLine("Session error");
      return;
    }

    if (type !== "message.part.updated") {
      return;
    }

    const part = asRecord(properties.part);
    const partType = asString(part?.type);
    const partId = asString(part?.id);
    if (!part || !partType || !partId) {
      return;
    }

    switch (partType) {
      case "reasoning":
        setStatusLine("Thinking...");
        return;
      case "subtask": {
        const agent = asString(part.agent) ?? "Task";
        upsertActivity(partId, (previous) => ({
          id: partId,
          title: agent,
          subtitle: asString(part.description),
          status: previous?.status ?? "running",
          details: previous?.details ?? ["Initializing..."],
          stats: previous?.stats ?? "Running...",
          accent: previous?.accent ?? hashColor(agent),
          updatedAt: Date.now(),
        }));
        return;
      }
      case "tool": {
        const tool = asString(part.tool) ?? "Tool";
        const state = asRecord(part.state);
        const summary = summarizeOpenCodeToolState(tool, state);
        const normalizedTool = tool.trim().toLowerCase();
        const touchedPath = extractOpenCodePath(state?.input)
          ?? extractOpenCodePath(state?.output)
          ?? extractOpenCodePath(state);
        if (
          asString(state?.status) === "completed"
          && touchedPath
          && (
            normalizedTool.includes("write")
            || normalizedTool.includes("edit")
            || normalizedTool.includes("patch")
            || normalizedTool.includes("delete")
            || normalizedTool.includes("remove")
            || normalizedTool.includes("move")
            || normalizedTool.includes("rename")
          )
        ) {
          trackTouchedPath(touchedPath);
        }

        upsertActivity(partId, (previous) => ({
          id: partId,
          title: tool,
          subtitle: asString(state?.title),
          status: summary.status,
          details: pushDetail(previous?.details ?? [], summary.detail),
          stats: summary.status === "done" ? "Done" : (summary.status === "failed" ? "Failed" : "Running..."),
          accent: previous?.accent ?? hashColor(tool),
          updatedAt: Date.now(),
        }));
        return;
      }
      case "patch": {
        const files = Array.isArray(part.files)
          ? part.files.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
          : [];

        upsertActivity(partId, (previous) => ({
          id: partId,
          title: "Patch",
          subtitle: undefined,
          status: "done",
          details: files.length > 0 ? summarizePaths(files, 4) : (previous?.details ?? ["Updated files"]),
          stats: `${files.length} file(s)`,
          accent: previous?.accent ?? "cyan",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "retry": {
        const attempt = asNumber(part.attempt);
        const error = asRecord(part.error);
        appendMessage("system", `Retry attempt ${attempt ?? "?"}: ${asString(error?.message) ?? "Unknown error"}`);
        setStatusLine("Retrying...");
        return;
      }
      case "step-finish": {
        const tokens = asRecord(part.tokens);
        const summary = [
          formatTokens(asNumber(tokens?.total)),
          typeof part.cost === "number" ? `cost=$${part.cost.toFixed(4)}` : undefined,
        ].filter(Boolean).join(" · ");

        if (summary) {
          setUsageLine(summary);
        }
        setStatusLine(`Step finished: ${asString(part.reason) ?? "done"}`);
        return;
      }
      case "step-start":
        setStatusLine("Step started");
        return;
      case "agent":
        setStatusLine(`Agent: ${asString(part.name) ?? "running"}`);
        return;
      default:
        return;
    }
  }

  function handleGenericActivity(event: AdapterEvent) {
    switch (event.type) {
      case "tool.use": {
        const id = nextId();
        upsertActivity(id, () => ({
          id,
          title: event.tool,
          subtitle: undefined,
          status: "running",
          details: [summarizeGenericValue(event.input)],
          stats: undefined,
          accent: hashColor(event.tool),
          updatedAt: Date.now(),
        }));
        return;
      }
      case "tool.result": {
        const id = nextId();
        upsertActivity(id, () => ({
          id,
          title: event.tool,
          subtitle: undefined,
          status: "done",
          details: [summarizeGenericValue(event.output)],
          stats: undefined,
          accent: hashColor(event.tool),
          updatedAt: Date.now(),
        }));
        return;
      }
      case "command": {
        const id = nextId();
        upsertActivity(id, () => ({
          id,
          title: "Command",
          subtitle: event.command,
          status: event.exitCode === 0 ? "done" : "failed",
          details: [truncate(firstLine(event.output) ?? "No output", 120)],
          stats: `exit ${event.exitCode}`,
          accent: event.exitCode === 0 ? "green" : "red",
          updatedAt: Date.now(),
        }));
        return;
      }
      case "file.change": {
        const id = nextId();
        upsertActivity(id, () => ({
          id,
          title: `File ${event.kind}`,
          subtitle: basename(event.path),
          status: "done",
          details: [event.path],
          stats: undefined,
          accent: "cyan",
          updatedAt: Date.now(),
        }));
        return;
      }
      default:
        return;
    }
  }

  function handleStatusEvent(event: Extract<AdapterEvent, { type: "status" }>) {
    switch (event.category) {
      case "session":
      case "turn":
      case "auth":
      case "compaction":
      case "permission":
      case "question":
        setStatusLine(event.message);
        return;
      case "retry":
        appendMessage("system", event.message);
        setStatusLine("Retrying...");
        return;
      default:
        return;
    }
  }

  function handleAdapterEvent(event: AdapterEvent) {
    switch (event.type) {
      case "session.started":
        setSessionId(event.sessionId);
        setReady(true);
        setStatusLine(`Connected to ${event.provider}${event.model ? ` (${event.model})` : ""}`);
        return;
      case "text.delta":
        if (isOpenCodeDocumentStageRun()) {
          return;
        }
        appendAssistantDelta(event.text);
        return;
      case "message.completed":
        syncAssistantMessage(event.text, false);
        return;
      case "thinking":
        setStatusLine("Thinking...");
        return;
      case "permission.request":
        setStatusLine(`Permission required: ${event.request.tool}`);
        return;
      case "question":
        setStatusLine(`Question: ${event.request.questions[0]?.header ?? "Clarification"}`);
        return;
      case "status":
        handleStatusEvent(event);
        return;
      case "provider.event":
        if (options.provider === "claudeCode") {
          handleClaudeProviderEvent(event.data);
        } else if (options.provider === "codex") {
          handleCodexProviderEvent(event.data);
        } else if (options.provider === "opencode") {
          handleOpenCodeProviderEvent(event.data);
        }
        return;
      case "tool.use":
      case "tool.result":
      case "command":
      case "file.change":
        if (event.type === "file.change") {
          trackTouchedPath(event.path);
        }
        if (options.provider === "codex" || options.provider === "opencode") {
          return;
        }
        handleGenericActivity(event);
        return;
      case "error":
        appendMessage("system", `Error: ${event.error}`);
        setErrorText(event.error);
        setStatusLine("Error");
        return;
      case "completed":
        setRunning(false);
        runningRef.current = false;
        setUsageLine(formatUsage(event));
        setStatusLine("Ready");
        if (isOpenCodeDocumentStageRun()) {
          void persistCompletedDocumentDraft(event.result.text);
          return;
        }
        finalizeAssistantTurn(event.result.text);
        void persistCompletedDocumentDraft(event.result.text);
        return;
      default:
        return;
    }
  }

  async function submitPrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    await runPrompt(trimmed, { role: "user", text: trimmed });
  }

  function resolvePermission(answer: string) {
    const prompt = pendingPermission;
    if (!prompt) {
      return;
    }

    const normalized = answer.trim().toLowerCase();
    if (!normalized) {
      return;
    }

    const allow = normalized === "1" || normalized === "y" || normalized === "yes" || normalized === "allow";
    prompt.resolve(
      allow
        ? { behavior: "allow", updatedInput: prompt.request.input }
        : { behavior: "deny", message: "Denied in Kyros." },
    );
    setPendingPermission(null);
    applyInputBuffer(createBufferState(""));
    setStatusLine(allow ? "Permission granted" : "Permission denied");
  }

  function cancelQuestionPrompt() {
    const prompt = pendingQuestion;
    if (!prompt) {
      return;
    }

    prompt.resolve(undefined);
    setPendingQuestion(null);
    setQuestionUi(null);
    setStatusLine("Question cancelled");
  }

  function submitQuestionPrompt() {
    const prompt = pendingQuestion;
    const ui = questionUi;
    if (!prompt || !ui) {
      return;
    }

    const unansweredIndex = prompt.request.questions.findIndex((question, index) =>
      !isQuestionAnswered(question, ui.drafts[index]!));

    if (unansweredIndex >= 0) {
      setQuestionUi((current) => current
        ? {
            ...current,
            activeTab: unansweredIndex,
          }
        : current);
      setStatusLine(`Answer ${prompt.request.questions[unansweredIndex]!.header} first.`);
      return;
    }

    prompt.resolve({
      answers: Object.fromEntries(
        prompt.request.questions.map((question, index) => ([
          question.id,
          buildQuestionAnswerValue(question, ui.drafts[index]!),
        ])),
      ),
    });
    setPendingQuestion(null);
    setQuestionUi(null);
    setStatusLine("Question answered");
  }

  function moveQuestionTab(delta: number) {
    if (!pendingQuestion) {
      return;
    }

    setQuestionUi((current) => {
      if (!current) {
        return current;
      }

      const tabCount = pendingQuestion.request.questions.length + 1;
      return {
        ...current,
        activeTab: (current.activeTab + delta + tabCount) % tabCount,
      };
    });
  }

  function moveQuestionRow(delta: number) {
    if (!pendingQuestion) {
      return;
    }

    setQuestionUi((current) => {
      if (!current || current.activeTab >= pendingQuestion.request.questions.length) {
        return current;
      }

      const questionIndex = current.activeTab;
      const question = pendingQuestion.request.questions[questionIndex]!;
      const rowCount = getQuestionRowCount(question);
      const activeRowByQuestion = [...current.activeRowByQuestion];
      const previousRow = activeRowByQuestion[questionIndex] ?? 0;
      activeRowByQuestion[questionIndex] = (previousRow + delta + rowCount) % rowCount;

      return {
        ...current,
        activeRowByQuestion,
      };
    });
  }

  function focusQuestionRow(rowIndex: number) {
    if (!pendingQuestion) {
      return;
    }

    setQuestionUi((current) => {
      if (!current || current.activeTab >= pendingQuestion.request.questions.length) {
        return current;
      }

      const questionIndex = current.activeTab;
      const question = pendingQuestion.request.questions[questionIndex]!;
      const rowCount = getQuestionRowCount(question);
      if (rowIndex < 0 || rowIndex >= rowCount) {
        return current;
      }

      const activeRowByQuestion = [...current.activeRowByQuestion];
      activeRowByQuestion[questionIndex] = rowIndex;
      return {
        ...current,
        activeRowByQuestion,
      };
    });
  }

  function toggleFocusedQuestionSelection() {
    if (!pendingQuestion || !questionUi) {
      return;
    }

    if (questionUi.activeTab >= pendingQuestion.request.questions.length) {
      submitQuestionPrompt();
      return;
    }

    const questionIndex = questionUi.activeTab;
    const question = pendingQuestion.request.questions[questionIndex]!;
    const rowIndex = questionUi.activeRowByQuestion[questionIndex] ?? 0;

    setQuestionUi((current) => {
      if (!current) {
        return current;
      }

      const drafts = [...current.drafts];
      const draft = {
        ...drafts[questionIndex]!,
        selectedOptionIndexes: [...drafts[questionIndex]!.selectedOptionIndexes],
      };

      if (isCustomQuestionRow(question, rowIndex)) {
        draft.customSelected = true;
        if (!question.multiSelect) {
          draft.selectedOptionIndexes = [];
        }
        drafts[questionIndex] = draft;
        return {
          ...current,
          drafts,
        };
      }

      if (question.multiSelect) {
        const existingIndex = draft.selectedOptionIndexes.indexOf(rowIndex);
        if (existingIndex >= 0) {
          draft.selectedOptionIndexes.splice(existingIndex, 1);
        } else {
          draft.selectedOptionIndexes.push(rowIndex);
        }
      } else {
        draft.selectedOptionIndexes = [rowIndex];
        draft.customSelected = false;
      }

      drafts[questionIndex] = draft;
      return {
        ...current,
        drafts,
      };
    });
  }

  function editFocusedQuestionCustom(key: TerminalKey): boolean {
    if (!pendingQuestion || !questionUi || questionUi.activeTab >= pendingQuestion.request.questions.length) {
      return false;
    }

    const questionIndex = questionUi.activeTab;
    const question = pendingQuestion.request.questions[questionIndex]!;
    const rowIndex = questionUi.activeRowByQuestion[questionIndex] ?? 0;
    if (!isCustomQuestionRow(question, rowIndex)) {
      return false;
    }

    const draft = questionUi.drafts[questionIndex]!;
    const nextBuffer = getEditedBuffer(createBufferState(draft.customValue, draft.customCursor), key);
    if (!nextBuffer) {
      return false;
    }

    setQuestionUi((current) => {
      if (!current) {
        return current;
      }

      const drafts = [...current.drafts];
      const nextDraft = {
        ...drafts[questionIndex]!,
        customSelected: true,
        customValue: nextBuffer.value,
        customCursor: nextBuffer.cursor,
      };

      if (!question.multiSelect) {
        nextDraft.selectedOptionIndexes = [];
      }

      drafts[questionIndex] = nextDraft;
      return {
        ...current,
        drafts,
      };
    });
    return true;
  }

  async function cycleInteractionMode() {
    if (runningRef.current) {
      appendMessage("system", "Wait for the current run to finish before switching modes.");
      return;
    }

    const nextMode = getNextInteractionMode(currentPermissionMode, currentRunMode);
    setCurrentPermissionMode(nextMode.permissionMode);
    setCurrentRunMode(nextMode.runMode);
    await connectSession(
      currentModel,
      `Switching to ${nextMode.label}...`,
      {
        permissionMode: nextMode.permissionMode,
        runMode: nextMode.runMode,
      },
    );
  }

  useTerminalKeypress((key) => {
    if (key.ctrl && key.name === "c") {
      void sessionRef.current?.close();
      exit();
      return;
    }

    if (pendingQuestion && questionUi) {
      if (isEscapeKey(key)) {
        cancelQuestionPrompt();
        return;
      }

      if (isShiftTabKey(key)) {
        moveQuestionTab(-1);
        return;
      }

      if (isTabKey(key)) {
        moveQuestionTab(1);
        return;
      }

      if (questionUi.activeTab < pendingQuestion.request.questions.length) {
        const questionIndex = questionUi.activeTab;
        const question = pendingQuestion.request.questions[questionIndex]!;
        const activeRow = questionUi.activeRowByQuestion[questionIndex] ?? 0;

        if (key.name === "up") {
          moveQuestionRow(-1);
          return;
        }

        if (key.name === "down") {
          moveQuestionRow(1);
          return;
        }

        const directIndex = Number.parseInt(key.sequence, 10);
        if (!Number.isNaN(directIndex) && key.sequence.trim().length > 0) {
          focusQuestionRow(directIndex - 1);
          return;
        }

        if (activeRow >= 0 && isCustomQuestionRow(question, activeRow) && editFocusedQuestionCustom(key)) {
          return;
        }

        if (key.name === "left") {
          moveQuestionTab(-1);
          return;
        }

        if (key.name === "right") {
          moveQuestionTab(1);
          return;
        }

        if (isEnterKey(key)) {
          toggleFocusedQuestionSelection();
          return;
        }
      } else if (isEnterKey(key)) {
        submitQuestionPrompt();
        return;
      }

      return;
    }

    if (modelPicker) {
      if (isEscapeKey(key)) {
        setModelPicker(null);
        applyInputBuffer(createBufferState(""));
        setStatusLine("Ready");
        return;
      }

      if (modelPicker.loading) {
        return;
      }

      if (!modelPicker.customMode) {
        if (key.name === "up") {
          setModelPicker((current) => {
            if (!current) return current;
            const filtered = filterModelOptions(current.options, current.filter);
            if (filtered.length === 0) return current;
            return {
              ...current,
              selectedIndex: (current.selectedIndex - 1 + filtered.length) % filtered.length,
            };
          });
          return;
        }

        if (key.name === "down") {
          setModelPicker((current) => {
            if (!current) return current;
            const filtered = filterModelOptions(current.options, current.filter);
            if (filtered.length === 0) return current;
            return {
              ...current,
              selectedIndex: (current.selectedIndex + 1) % filtered.length,
            };
          });
          return;
        }

        if (isEnterKey(key)) {
          void handleSubmittedInput(inputValue);
          return;
        }

        // Backspace removes last filter character
        if (key.name === "backspace" || key.name === "delete") {
          setModelPicker((current) => {
            if (!current || !current.filter) return current;
            return { ...current, filter: current.filter.slice(0, -1), selectedIndex: 0 };
          });
          return;
        }

        // Printable characters update the search filter
        const ch = key.sequence;
        if (ch && ch.length === 1 && ch >= " " && !key.ctrl && !key.meta && key.name !== "tab") {
          setModelPicker((current) => {
            if (!current) return current;
            return { ...current, filter: current.filter + ch, selectedIndex: 0 };
          });
          return;
        }

        return;
      }
    }

    if (sessionPicker) {
      if (isEscapeKey(key)) {
        setSessionPicker(null);
        applyInputBuffer(createBufferState(""));
        setStatusLine("Ready");
        return;
      }
      if (sessionPicker.loading) return;

      const filtered = sessionPicker.filter
        ? sessionPicker.sessions.filter((s) => s.summary.toLowerCase().includes(sessionPicker.filter.toLowerCase()) || s.provider.toLowerCase().includes(sessionPicker.filter.toLowerCase()))
        : sessionPicker.sessions;

      if (key.name === "up") {
        setSessionPicker((c) => c && filtered.length > 0 ? { ...c, selectedIndex: (c.selectedIndex - 1 + filtered.length) % filtered.length } : c);
        return;
      }
      if (key.name === "down") {
        setSessionPicker((c) => c && filtered.length > 0 ? { ...c, selectedIndex: (c.selectedIndex + 1) % filtered.length } : c);
        return;
      }
      if (isEnterKey(key)) {
        const selected = filtered[sessionPicker.selectedIndex];
        if (selected) resumeSession(selected);
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        setSessionPicker((c) => c && c.filter ? { ...c, filter: c.filter.slice(0, -1), selectedIndex: 0 } : c);
        return;
      }
      const ch = key.sequence;
      if (ch && ch.length === 1 && ch >= " " && !key.ctrl && !key.meta && key.name !== "tab") {
        setSessionPicker((c) => c ? { ...c, filter: c.filter + ch, selectedIndex: 0 } : c);
        return;
      }
      return;
    }

    if (commandMenuVisible) {
      if (key.name === "up") {
        setSlashSelectionIndex((current) => {
          if (visibleSlashCommands.length === 0) {
            return 0;
          }
          return (current - 1 + visibleSlashCommands.length) % visibleSlashCommands.length;
        });
        return;
      }

      if (key.name === "down") {
        setSlashSelectionIndex((current) => {
          if (visibleSlashCommands.length === 0) {
            return 0;
          }
          return (current + 1) % visibleSlashCommands.length;
        });
        return;
      }
    }

    if (!isShiftTabKey(key) && !pendingPermission && !pendingQuestion && !modelPicker && !commandMenuVisible && currentDocumentStage) {
      if (isTabKey(key)) {
        setWorkflowFocus((current) =>
          current === "input" && workflowCanApprove ? "approve" : "input");
        return;
      }

      if (workflowFocus === "approve") {
        if (isEnterKey(key)) {
          if (workflowCanApprove) {
            void approveCurrentDocumentStage();
          } else {
            setStatusLine(`Wait for a ${currentDocumentStage.fileName} draft before approving.`);
          }
        }
        return;
      }
    }

    if (isShiftTabKey(key)) {
      void cycleInteractionMode();
      return;
    }

    if (isEscapeKey(key) && runningRef.current) {
      void sessionRef.current?.interrupt();
      appendMessage("system", "Interrupt requested.");
      setStatusLine("Interrupting...");
      return;
    }

    if (key.ctrl && key.name === "j") {
      updateInputBuffer((current) => insertIntoBuffer(current, "\n"));
      return;
    }

    if (isEnterKey(key)) {
      const wantsNewline =
        key.shift
        || key.meta
        || key.super
        || (key.ctrl && (key.name === "return" || key.name === "j"));

      if (wantsNewline) {
        updateInputBuffer((current) => insertIntoBuffer(current, "\n"));
        return;
      }

      void handleSubmittedInput(inputValue);
      return;
    }

    updateInputBuffer((current) => getEditedBuffer(current, key) ?? current);
  });

  useEffect(() => {
    registerBuiltinAdapters();
    destroyedRef.current = false;
    void connectSession(currentModel, "Connecting...");

    return () => {
      destroyedRef.current = true;
      void sessionRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.cwd, options.provider, options.questionMode, options.systemPrompt]);

  useEffect(() => {
    if (!ready || !options.initialPrompt || sentInitialPromptRef.current) {
      return;
    }
    sentInitialPromptRef.current = true;
    void handleSubmittedInput(options.initialPrompt);
  }, [options.initialPrompt, ready]);

  useEffect(() => {
    activitiesRef.current = activities;
  }, [activities]);

  useEffect(() => {
    documentWorkflowRef.current = documentWorkflow;
  }, [documentWorkflow]);

  useEffect(() => {
    const nextWorkflow = createDocumentWorkflowState(options.cwd);
    documentWorkflowRef.current = nextWorkflow;
    activeDocumentStageKeyRef.current = null;
    setDocumentWorkflow(nextWorkflow);
    setWorkflowFocus("input");
  }, [options.cwd]);

  useEffect(() => {
    if (!pendingQuestion) {
      setQuestionUi(null);
      return;
    }

    setQuestionUi(createQuestionUiState(pendingQuestion.request));
  }, [pendingQuestion]);

  const slashCommands = useMemo(() => buildSlashCommands(), []);
  const slashQuery = useMemo(() => {
    const trimmed = inputValue.trimStart();
    if (!trimmed.startsWith("/")) {
      return undefined;
    }

    const withoutSlash = trimmed.slice(1);
    return withoutSlash.includes(" ")
      ? undefined
      : withoutSlash.toLowerCase();
  }, [inputValue]);
  const visibleSlashCommands = useMemo(() => {
    if (slashQuery == null) {
      return [];
    }

    return slashCommands.filter((command) =>
      command.name.slice(1).includes(slashQuery)
      || command.description.toLowerCase().includes(slashQuery),
    );
  }, [slashCommands, slashQuery]);
  const commandMenuVisible =
    slashQuery != null
    && !pendingPermission
    && !pendingQuestion
    && !modelPicker;

  useEffect(() => {
    setSlashSelectionIndex(0);
  }, [slashQuery]);

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const activitiesById = useMemo(
    () => new Map(activities.map((activity) => [activity.id, activity])),
    [activities],
  );
  const visibleFeed = useMemo(() => feed, [feed]);

  const permissionLines = pendingPermission
    ? [
        pendingPermission.request.tool,
        pendingPermission.request.description ?? "Choose whether to allow this action.",
        "1. Allow",
        "2. Deny",
      ]
    : [];
  const workflowComplete = !currentDocumentStage;
  const workflowCanApprove = Boolean(currentDocumentStage?.draft?.trim()) && !running;
  const nextWorkflowStage = !workflowComplete
    ? documentWorkflow.stages[documentWorkflow.currentIndex + 1]
    : undefined;
  const workflowStages = documentWorkflow.stages.map((stage) => ({
    key: stage.key,
    fileName: stage.fileName,
    approved: stage.approved,
    active: !workflowComplete && stage.key === currentDocumentStage?.key,
    hasDraft: Boolean(stage.draft?.trim()),
  }));

  const inputPlaceholder = pendingPermission
    ? "Type 1 or 2"
    : modelPicker?.customMode
        ? (options.provider === "opencode" ? "Type provider/model" : "Type a model value")
        : modelPicker
          ? "Use arrows, then press Enter"
          : running
            ? workflowComplete
              ? "Running... (esc to interrupt)"
              : `Drafting ${currentDocumentStage?.fileName}... (esc to interrupt)`
            : (!ready
                ? "Connecting..."
                : (workflowComplete
                    ? "Type a prompt"
                    : (currentDocumentStage?.draft?.trim()
                        ? `Refine ${currentDocumentStage.fileName} or Tab approve`
                        : `Describe ${currentDocumentStage?.fileName}`)));

  const modeColor = getModeColor(currentPermissionMode, currentRunMode);
  const divider = "─".repeat(columns);
  const footerStatus = errorText
    ? statusLine
    : (usageLine ?? statusLine);

  return (
    <Box flexDirection="column">
      <Header
        provider={currentProvider}
        currentModel={currentModel}
        currentRunMode={currentRunMode}
        currentPermissionMode={currentPermissionMode}
      />

      {visibleFeed.length > 0 ? (
        <Box flexDirection="column">
          {visibleFeed.map((entry) => {
            if (entry.kind === "message") {
              const message = messagesById.get(entry.id);
              return message ? <MessageView key={`message-${entry.id}`} message={message} columns={columns} /> : null;
            }

            const activity = activitiesById.get(entry.id);
            return activity ? <ActivityView key={`activity-${entry.id}`} activity={activity} /> : null;
          })}
        </Box>
      ) : null}

      {pendingPermission ? (
        <PromptModal title="Permission Request" lines={permissionLines} accent="yellow" />
      ) : null}

      {pendingQuestion && questionUi ? (
        <QuestionModal request={pendingQuestion.request} questionUi={questionUi} />
      ) : null}

      {modelPicker ? (
        <ModelPickerModal provider={currentProvider} modelPicker={modelPicker} />
      ) : null}

      {sessionPicker ? (
        <SessionPickerModal sessionPicker={sessionPicker} formatTime={formatSessionTime} />
      ) : null}

      {running ? (
        <ThinkingIndicator label={statusLine === "Thinking..." ? "Thinking" : statusLine.replace(/\.{3}$/, "")} color={modeColor} />
      ) : null}

      <Text color={modeColor}>{divider}</Text>

      {!pendingQuestion ? (
        <PromptEditor
          buffer={inputBuffer}
          placeholder={inputPlaceholder}
          prefix="❯"
          prefixColor={pendingPermission ? "yellow" : modeColor}
          showCursor={workflowComplete || workflowFocus === "input" || Boolean(pendingPermission) || Boolean(modelPicker)}
          dimColor={!workflowComplete && workflowFocus === "approve"}
        />
      ) : null}

      <Text color={modeColor}>{divider}</Text>

      {commandMenuVisible ? (
        <CommandPalette commands={visibleSlashCommands} selectedIndex={slashSelectionIndex} />
      ) : null}

      <DocumentWorkflowPanel
        stages={workflowStages}
        currentFileName={currentDocumentStage?.fileName}
        complete={workflowComplete}
        focus={workflowFocus}
        canApprove={workflowCanApprove}
        running={running}
        nextFileName={nextWorkflowStage?.fileName}
      />

      <Box justifyContent="space-between">
        <Text color="gray">
          {interactionMode.label} · shift+tab mode
        </Text>
        <Text color={errorText ? "red" : "gray"}>
          {footerStatus}
          {sessionId ? ` · ${sessionId}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

export async function runTui(options: TuiOptions): Promise<TuiResult> {
  let action: TuiAction | undefined;
  const app = render(<LoopsInkTui options={options} onAction={(nextAction) => {
    action = nextAction;
  }} />, {
    exitOnCtrlC: false,
    patchConsole: false,
    kittyKeyboard: {
      mode: "enabled",
    },
  });

  await app.waitUntilExit();
  return { action };
}
