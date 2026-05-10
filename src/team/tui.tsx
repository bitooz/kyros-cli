import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  TeamHeader,
  MemberPanel,
  GroupChatPanel,
  RunFooter,
  type AgentActivity,
  type AgentEventEntry,
} from "./components.js";
import type {
  TeamMemberDefinition,
  TeamMessage,
  TeamRunOptions,
  TeamRunResult,
  TeamRuntimeDefinition,
  TeamRuntimeEvent,
  TeamTask,
} from "./types.js";

// ── State shape ────────────────────────────────────────────────────────

interface TeamTuiState {
  started: boolean;
  cwd: string;
  teamName?: string;
  orchestrator?: TeamMemberDefinition;
  coworkers: TeamMemberDefinition[];
  runtimeConfig?: TeamRuntimeDefinition;
  tasks: TeamTask[];
  activities: AgentActivity[];
  messages: TeamMessage[];
  turns: number;
  idleTicks: number;
  stopReason?: string;
  blockedQuestion?: string;
}

const INITIAL_STATE: TeamTuiState = {
  started: false,
  cwd: "",
  teamName: undefined,
  orchestrator: undefined,
  coworkers: [],
  runtimeConfig: undefined,
  tasks: [],
  activities: [],
  messages: [],
  turns: 0,
  idleTicks: 0,
};

// ── Event reducer ──────────────────────────────────────────────────────

let eventSeq = 0;

function reduceEvent(
  prev: TeamTuiState,
  event: TeamRuntimeEvent,
): TeamTuiState {
  switch (event.type) {
    case "runtime.started":
      return {
        ...prev,
        started: true,
        cwd: event.cwd,
        teamName: event.teamName,
        orchestrator: event.orchestrator,
        coworkers: event.coworkers,
        runtimeConfig: event.runtimeConfig,
        tasks:
          prev.tasks.length > 0
            ? prev.tasks
            : Array.from({ length: event.taskCount }, (_, i) => ({
                id: `placeholder-${i}`,
                title: "",
                checked: false,
                status: "todo" as const,
                lineIndex: i,
              })),
      };

    case "turn.started": {
      const existing = prev.activities.find(
        (a) =>
          a.agentId === event.agentId && a.turnNumber === event.turnNumber,
      );
      if (existing) return prev;

      const activity: AgentActivity = {
        agentId: event.agentId,
        agentName: event.agentName,
        role: event.role,
        turnNumber: event.turnNumber,
        status: "running",
        startedAt: Date.now(),
        textBuffer: "",
        events: [],
      };
      return {
        ...prev,
        turns: Math.max(prev.turns, event.turnNumber),
        idleTicks: 0,
        activities: [...prev.activities, activity],
      };
    }

    case "agent.text.delta": {
      return updateActivity(prev, event.agentId, (a) => ({
        ...a,
        textBuffer: a.textBuffer + event.text,
      }));
    }

    case "agent.status":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: summarizeStatusLine(event.category, event.message),
        kind: "status",
      });

    case "agent.thinking":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: event.text,
        kind: "thinking",
      });

    case "agent.tool.use":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: summarizeToolUseLine(event.tool, event.input),
        kind: "tool",
      });

    case "agent.tool.result":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: summarizeToolResultLine(event.tool, event.output),
        kind: "tool-result",
      });

    case "agent.command":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: summarizeCommandLine(event.command, event.exitCode, event.output),
        kind: "command",
      });

    case "agent.file.change":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: summarizeFileChangeLine(event.kind, event.path),
        kind: "file",
      });

    case "agent.permission":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: `Permission · ${event.tool}`,
        kind: "permission",
      });

    case "agent.error":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: event.message,
        kind: "error",
      });

    case "agent.session.started":
      return pushAgentEvent(prev, event.agentId, {
        id: ++eventSeq,
        text: `Session · ${event.provider}${event.model ? ` · ${event.model}` : ""}`,
        kind: "status",
      });

    case "turn.completed":
      return updateActivity(prev, event.agentId, (a) =>
        a.turnNumber === event.turnNumber
          ? { ...a, status: "done", summary: event.summary, completedAt: Date.now() }
          : a,
      );

    case "turn.failed":
      return updateActivity(prev, event.agentId, (a) =>
        a.turnNumber === event.turnNumber
          ? { ...a, status: "failed", error: event.error, completedAt: Date.now() }
          : a,
      );

    case "message.routed":
      return {
        ...prev,
        messages: [...prev.messages, event.message],
      };

    case "tasks.updated":
      return { ...prev, tasks: event.tasks };

    case "idle.tick":
      return { ...prev, idleTicks: event.count };

    case "runtime.stopped":
      return {
        ...prev,
        stopReason: event.reason,
        turns: event.turns,
        tasks: event.tasks,
        blockedQuestion: event.blockedQuestion,
      };
  }
}

function updateActivity(
  prev: TeamTuiState,
  agentId: string,
  fn: (a: AgentActivity) => AgentActivity,
): TeamTuiState {
  // Update the most recent activity for this agent
  const idx = findLatestActivity(prev.activities, agentId);
  if (idx < 0) return prev;
  const updated = [...prev.activities];
  updated[idx] = fn(updated[idx]!);
  return { ...prev, activities: updated };
}

function pushAgentEvent(
  prev: TeamTuiState,
  agentId: string,
  entry: AgentEventEntry,
): TeamTuiState {
  return updateActivity(prev, agentId, (a) => ({
    ...a,
    events: [...a.events, entry],
  }));
}

function findLatestActivity(
  activities: AgentActivity[],
  agentId: string,
): number {
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]!.agentId === agentId) return i;
  }
  return -1;
}

function summarize(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string")
    return truncateInline(value, 120);
  try {
    const s = JSON.stringify(value);
    return truncateInline(s, 120);
  } catch {
    return String(value);
  }
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

function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

function truncateInline(value: string, maxLength = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function shortPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join("/");
}

function summarizeToolUseLine(tool: string, input: unknown): string {
  const record = asRecord(input);

  switch (tool) {
    case "Bash":
      return `Bash · ${truncateInline(asString(record?.description) ?? asString(record?.command) ?? "command", 96)}`;
    case "Read": {
      const path = asString(record?.file_path) ?? asString(record?.filePath) ?? asString(record?.path);
      return `Read · ${path ? shortPath(path) : "file"}`;
    }
    case "Write": {
      const path = asString(record?.file_path) ?? asString(record?.filePath) ?? asString(record?.path);
      return `Write · ${path ? shortPath(path) : "file"}`;
    }
    case "Edit":
    case "MultiEdit": {
      const path = asString(record?.file_path) ?? asString(record?.filePath) ?? asString(record?.path);
      return `${tool} · ${path ? shortPath(path) : "file"}`;
    }
    case "Glob":
      return `Glob · ${truncateInline(asString(record?.pattern) ?? "*", 96)}`;
    case "Grep":
      return `Grep · ${truncateInline(asString(record?.pattern) ?? "", 96)}`;
    case "LS":
      return `List · ${truncateInline(asString(record?.path) ?? ".", 96)}`;
    case "Task":
      return `Task · ${truncateInline(asString(record?.description) ?? summarize(input), 96)}`;
    default:
      return record && Object.keys(record).length > 0
        ? `${tool} · ${truncateInline(summarize(input), 96)}`
        : tool;
  }
}

function summarizeToolResultLine(tool: string, output: unknown): string {
  if (typeof output === "string") {
    return `${tool} ✓ ${truncateInline(output, 108)}`;
  }

  const record = asRecord(output);
  if (!record) {
    return `${tool} ✓ ${summarize(output)}`;
  }

  const fileRecord = asRecord(record.file);
  const filePath =
    asString(fileRecord?.filePath) ??
    asString(record.filePath) ??
    asString(record.path);
  const lineCount = asNumber(fileRecord?.numLines) ?? asNumber(record.numLines);
  if (tool === "Read" && filePath) {
    return `Read ✓ ${shortPath(filePath)}${lineCount ? ` · ${lineCount} lines` : ""}`;
  }
  if (filePath) {
    return `${tool} ✓ ${shortPath(filePath)}`;
  }

  const stdout = asString(record.stdout);
  const stderr = asString(record.stderr);
  const text = firstLine(stdout) ?? firstLine(stderr);
  if (text) {
    return `${tool} ✓ ${truncateInline(text, 108)}`;
  }

  const content = Array.isArray(record.content) ? record.content : [];
  for (const entry of content) {
    const block = asRecord(entry);
    const textBlock = asString(block?.text);
    if (textBlock) {
      return `${tool} ✓ ${truncateInline(textBlock, 108)}`;
    }
  }

  return `${tool} ✓ ${truncateInline(summarize(output), 108)}`;
}

function summarizeCommandLine(command: string, exitCode: number, output?: string): string {
  const head = firstLine(output);
  const suffix = exitCode === 0 ? "ok" : `exit ${exitCode}`;
  return head
    ? `Shell · ${truncateInline(command, 72)} · ${suffix} · ${truncateInline(head, 60)}`
    : `Shell · ${truncateInline(command, 100)} · ${suffix}`;
}

function summarizeFileChangeLine(kind: string, path: string): string {
  return `${capitalize(kind)} · ${shortPath(path)}`;
}

function summarizeStatusLine(category: string, message: string): string {
  const prefix = category === "step" || category === "turn"
    ? capitalize(category)
    : capitalize(category.replace(/[_-]/g, " "));
  return `${prefix} · ${truncateInline(message, 112)}`;
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function chunkPanels<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

// ── Ink root component ─────────────────────────────────────────────────

function TeamTuiApp({
  eventSource,
  onRequestExit,
}: {
  eventSource: (handler: (event: TeamRuntimeEvent) => void) => void;
  onRequestExit: () => void;
}) {
  const [state, setState] = useState<TeamTuiState>(INITIAL_STATE);
  const [focusedPanelIndex, setFocusedPanelIndex] = useState(0);
  const [scrollOffsets, setScrollOffsets] = useState<Record<string, number>>({});
  const [isExpandedView, setIsExpandedView] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const pendingEventsRef = useRef<TeamRuntimeEvent[]>([]);
  const { exit } = useApp();
  const { stdout } = useStdout();

  const flushPendingEvents = useCallback(() => {
    if (pendingEventsRef.current.length === 0) {
      return;
    }

    const batch = pendingEventsRef.current.splice(0);
    setState((prev) => batch.reduce(reduceEvent, prev));
  }, []);

  const handleEvent = useCallback((event: TeamRuntimeEvent) => {
    pendingEventsRef.current.push(event);
    if (
      event.type === "runtime.started" ||
      event.type === "runtime.stopped"
    ) {
      flushPendingEvents();
    }
  }, [flushPendingEvents]);

  useEffect(() => {
    eventSource(handleEvent);
    return () => {
      flushPendingEvents();
    };
  }, [eventSource, handleEvent, flushPendingEvents]);

  useEffect(() => {
    const timer = setInterval(() => {
      flushPendingEvents();
    }, 140);
    return () => clearInterval(timer);
  }, [flushPendingEvents]);

  const hasRunningActivity = state.activities.some((activity) => activity.status === "running");
  useEffect(() => {
    if (!hasRunningActivity) {
      return;
    }

    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 250);
    return () => clearInterval(timer);
  }, [hasRunningActivity]);

  const members = state.orchestrator
    ? [state.orchestrator, ...state.coworkers]
    : state.coworkers;
  const memberNames = Object.fromEntries(
    members.map((member) => [member.id, member.name]),
  );
  const panelIds = [
    ...members.map((member) => member.id),
    "group-chat",
  ];

  useEffect(() => {
    setFocusedPanelIndex((prev) =>
      panelIds.length === 0 ? 0 : Math.min(prev, panelIds.length - 1),
    );
  }, [panelIds.length]);

  const cycleFocus = useCallback((delta: number) => {
    setFocusedPanelIndex((prev) => {
      if (panelIds.length === 0) {
        return 0;
      }
      return (prev + delta + panelIds.length) % panelIds.length;
    });
  }, [panelIds.length]);

  const adjustScroll = useCallback((delta: number) => {
    const panelId = panelIds[focusedPanelIndex];
    if (!panelId) {
      return;
    }

    setScrollOffsets((prev) => ({
      ...prev,
      [panelId]: Math.max(0, (prev[panelId] ?? 0) + delta),
    }));
  }, [focusedPanelIndex, panelIds]);

  // Allow Ctrl+C (handled by Ink/useApp automatically) and 'q' to exit
  useInput((input, key) => {
    if (key.ctrl && (input === "o" || input === "O")) {
      setIsExpandedView((prev) => !prev);
      return;
    }

    if (input === "q" && !key.ctrl && !key.meta && state.stopReason) {
      onRequestExit();
      exit();
      return;
    }

    if (key.leftArrow || input === "[") {
      cycleFocus(-1);
      return;
    }

    if (key.rightArrow || input === "]") {
      cycleFocus(1);
      return;
    }

    if (key.upArrow || input === "k") {
      adjustScroll(1);
      return;
    }

    if (key.downArrow || input === "j") {
      adjustScroll(-1);
      return;
    }
  }, { isActive: true });

  const columns = stdout?.columns ?? process.stdout.columns ?? 120;
  const rows = stdout?.rows ?? process.stdout.rows ?? 40;
  // Support up to 3 columns on very wide terminals
  const columnCount = columns >= 200 ? 3 : columns >= 120 ? 2 : 1;
  const panelCount = panelIds.length;
  const rowCount = Math.max(1, Math.ceil(panelCount / columnCount));
  // TeamHeader renders 3 lines (no marginBottom), loading state is 1 line
  const headerHeight = state.started && state.orchestrator ? 3 : 1;
  const footerHeight = state.stopReason
    ? (state.blockedQuestion ? 3 : 2)
    : 1;
  const availablePanelHeight = Math.max(
    12,
    rows - headerHeight - footerHeight,
  );
  // Fixed equal row heights — each row gets the same canvas size
  const panelHeight = Math.max(10, Math.floor(availablePanelHeight / rowCount));
  const expandedPanelHeight = Math.max(10, availablePanelHeight);
  const expandedViewportLines = Math.max(4, expandedPanelHeight - 4);
  // Base panel width; last-row panels that don't fill a row will expand to full width
  const basePanelWidth = columnCount === 1
    ? columns
    : Math.max(42, Math.floor(columns / columnCount));

  function makeMemberPanel(
    member: TeamMemberDefinition,
    width: number,
    panelViewportLines: number,
    panelHeightOverride?: number,
    showBottomBorder = true,
    showRightBorder = true,
  ) {
    const idx = findLatestActivity(state.activities, member.id);
    const activity = idx >= 0 ? state.activities[idx] : undefined;
    // Collect all activities for this agent for cumulative timer
    const agentActivities = state.activities.filter((a) => a.agentId === member.id);
    return {
      key: member.id,
      label: `${member.name} (${member.role})`,
      node: (
        <MemberPanel
          member={member}
          activity={activity}
          allActivities={agentActivities}
          nowMs={nowMs}
          width={width}
          viewportLines={panelViewportLines}
          scrollOffset={scrollOffsets[member.id] ?? 0}
          focused={panelIds[focusedPanelIndex] === member.id}
          showBottomBorder={showBottomBorder}
          showRightBorder={showRightBorder}
        />
      ),
      height: panelHeightOverride ?? panelHeight,
    };
  }

  function makeGroupChatPanel(
    width: number,
    panelViewportLines: number,
    panelHeightOverride?: number,
    showBottomBorder = true,
    showRightBorder = true,
  ) {
    return {
      key: "group-chat",
      label: "Group Chat",
      node: (
        <GroupChatPanel
          messages={state.messages}
          limit={state.messages.length}
          memberNames={memberNames}
          width={width}
          viewportLines={panelViewportLines}
          scrollOffset={scrollOffsets["group-chat"] ?? 0}
          focused={panelIds[focusedPanelIndex] === "group-chat"}
          showBottomBorder={showBottomBorder}
          showRightBorder={showRightBorder}
        />
      ),
      height: panelHeightOverride ?? panelHeight,
    };
  }

  const focusedPanelId = panelIds[focusedPanelIndex];

  // Build grid panels with fixed equal row heights.
  // Non-last rows drop their bottom border so the next row's top border acts as divider.
  const panelDefs = [
    ...members.map((m) => ({ kind: "member" as const, member: m })),
    { kind: "chat" as const },
  ] as Array<{ kind: "member"; member: TeamMemberDefinition } | { kind: "chat" }>;
  const total = panelDefs.length;
  const lastRowStart = total - (total % columnCount || columnCount);

  const gridPanels = panelDefs.map((def, index) => {
    const isLastRow = index >= lastRowStart;
    const showBottomBorder = isLastRow;
    // Only the rightmost panel in each row shows a right border
    const colInRow = index % columnCount;
    const panelsInThisRow = isLastRow ? (total % columnCount || columnCount) : columnCount;
    const showRightBorder = colInRow === panelsInThisRow - 1;
    const overhead = showBottomBorder ? 4 : 3;
    const pViewportLines = Math.max(2, panelHeight - overhead);
    const width = panelsInThisRow < columnCount
      ? Math.max(basePanelWidth, Math.floor(columns / panelsInThisRow))
      : basePanelWidth;
    return def.kind === "member"
      ? makeMemberPanel(def.member, width, pViewportLines, panelHeight, showBottomBorder, showRightBorder)
      : makeGroupChatPanel(width, pViewportLines, panelHeight, showBottomBorder, showRightBorder);
  });

  const expandedPanel = (() => {
    if (!isExpandedView || !focusedPanelId) {
      return undefined;
    }

    if (focusedPanelId === "group-chat") {
      return makeGroupChatPanel(columns, expandedViewportLines, expandedPanelHeight);
    }

    const member = members.find((entry) => entry.id === focusedPanelId);
    if (!member) {
      return undefined;
    }

    return makeMemberPanel(member, columns, expandedViewportLines, expandedPanelHeight);
  })();

  const panelRows = chunkPanels(gridPanels, columnCount);
  const focusedPanelLabel = gridPanels[focusedPanelIndex]?.label;
  const runningCount = state.activities.filter(
    (a) => a.status === "running",
  ).length;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {state.started && state.orchestrator ? (
        <TeamHeader
          cwd={state.cwd}
          teamName={state.teamName}
          orchestrator={state.orchestrator}
          coworkers={state.coworkers}
          taskCount={state.tasks.length}
          doneCount={state.tasks.filter((t) => t.status === "done").length}
          runtimeConfig={state.runtimeConfig}
          width={columns}
        />
      ) : (
        <Text color="gray">Loading team project...</Text>
      )}

      <Box flexDirection="column" flexGrow={1}>
        {expandedPanel ? (
          <Box flexDirection="row" height={expandedPanel.height}>
            <Box key={expandedPanel.key} height={expandedPanel.height} flexGrow={1}>
              {expandedPanel.node}
            </Box>
          </Box>
        ) : panelRows.map((row, rowIndex) => (
          <Box
            key={`panel-row-${rowIndex}`}
            flexDirection="row"
            height={panelHeight}
          >
            {row.map((panel) => (
              <Box
                key={panel.key}
                height={panel.height}
                flexGrow={1}
              >
                {panel.node}
              </Box>
            ))}
          </Box>
        ))}
      </Box>

      <RunFooter
        stopReason={state.stopReason}
        turns={state.turns}
        blockedQuestion={state.blockedQuestion}
        activeAgents={runningCount}
        idleTicks={state.idleTicks}
        maxIdleTurns={state.runtimeConfig?.maxIdleTurns}
        doneTaskCount={state.tasks.filter((t) => t.status === "done").length}
        totalTaskCount={state.tasks.length}
        focusedPanelLabel={focusedPanelLabel}
        expandedView={isExpandedView}
      />
    </Box>
  );
}

// ── Public entry point ─────────────────────────────────────────────────

export async function runTeamTui(
  options: TeamRunOptions,
  runTeam: (
    options: TeamRunOptions,
    onEvent: (event: TeamRuntimeEvent) => void,
  ) => Promise<TeamRunResult>,
): Promise<TeamRunResult> {
  let handler: ((event: TeamRuntimeEvent) => void) | null = null;
  let resolveExitRequest: (() => void) | null = null;
  const exitRequested = new Promise<void>((resolve) => {
    resolveExitRequest = resolve;
  });

  const eventSource = (h: (event: TeamRuntimeEvent) => void) => {
    handler = h;
  };

  const { unmount, waitUntilExit } = render(
    <TeamTuiApp
      eventSource={eventSource}
      onRequestExit={() => resolveExitRequest?.()}
    />,
  );

  // Small delay to let the first render register the handler
  await new Promise((r) => setTimeout(r, 50));

  const emit = (event: TeamRuntimeEvent) => {
    handler?.(event);
  };

  try {
    const result = await runTeam(options, emit);
    await Promise.race([
      waitUntilExit(),
      exitRequested.then(() => undefined),
    ]);
    return result;
  } catch (error) {
    unmount();
    throw error;
  }
}
