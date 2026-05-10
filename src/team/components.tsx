import { Box, Text } from "ink";
import React from "react";
import type {
  TeamMemberDefinition,
  TeamMessage,
  TeamRuntimeDefinition,
  TeamTask,
  TeamTaskStatus,
} from "./types.js";

// ── Header ─────────────────────────────────────────────────────────────

function formatMember(member: TeamMemberDefinition): string {
  const model = member.model ? ` · ${member.model}` : "";
  return `${member.name} (${member.role}/${member.provider}${model})`;
}

export function TeamHeader({
  cwd,
  teamName,
  orchestrator,
  coworkers,
  taskCount,
  doneCount,
  runtimeConfig,
  width,
}: {
  cwd: string;
  teamName?: string;
  orchestrator: TeamMemberDefinition;
  coworkers: TeamMemberDefinition[];
  taskCount: number;
  doneCount: number;
  runtimeConfig?: TeamRuntimeDefinition;
  width?: number;
}) {
  const maxWidth = width ?? 80;
  const progressWidth = Math.max(20, Math.min(48, maxWidth - 24));
  const memberSummary = truncate(
    [orchestrator, ...coworkers]
      .map((member) => `${member.name}/${member.role}/${member.provider}${member.model ? `:${member.model}` : ""}`)
      .join("  "),
    Math.max(32, maxWidth - 2),
  );
  const statusLine = [
    `tasks ${doneCount}/${taskCount}`,
    runtimeConfig ? `idle ${runtimeConfig.maxIdleTurns}` : undefined,
    runtimeConfig ? `parallel ${runtimeConfig.maxConcurrentAgents}` : undefined,
    truncate(cwd, Math.max(24, maxWidth - 42)),
  ]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <Box width={width} flexDirection="column">
      <Text>
        <Text color="cyan" bold>Kyros team</Text>
        {teamName ? <Text color="yellow"> · {teamName}</Text> : null}
        <Text color="gray">  {statusLine}</Text>
      </Text>
      <Text color="gray" dimColor>{memberSummary}</Text>
      {taskCount > 0 ? <ProgressBar current={doneCount} total={taskCount} width={progressWidth} /> : null}
    </Box>
  );
}

// ── Progress bar ───────────────────────────────────────────────────────

function ProgressBar({ current, total, width = 30 }: { current: number; total: number; width?: number }) {
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  const color = ratio >= 1 ? "green" : ratio >= 0.5 ? "yellow" : "cyan";

  return (
    <Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text color="gray" dimColor>{"░".repeat(empty)}</Text>
      <Text color="gray"> {pct}% ({current}/{total})</Text>
    </Text>
  );
}

// ── Task list ──────────────────────────────────────────────────────────

function statusColor(status: TeamTaskStatus): string {
  switch (status) {
    case "done":
      return "green";
    case "in_progress":
      return "yellow";
    case "blocked":
      return "red";
    case "todo":
    default:
      return "gray";
  }
}

function statusIcon(status: TeamTaskStatus): string {
  switch (status) {
    case "done":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "blocked":
      return "[!]";
    case "todo":
    default:
      return "[ ]";
  }
}

export function TaskList({ tasks }: { tasks: TeamTask[] }) {
  if (tasks.length === 0) {
    return <Text color="gray">No tasks.</Text>;
  }

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const progressLabel = `${doneCount}/${tasks.length} done`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white" bold>
        Tasks <Text color="gray">({progressLabel})</Text>
      </Text>
      {tasks.map((task) => (
        <Box key={task.id} flexDirection="column">
          <Text color={statusColor(task.status)}>
            {"  "}
            {statusIcon(task.status)} {task.title}
            {task.assignee ? (
              <Text color="gray"> [{task.assignee}]</Text>
            ) : null}
          </Text>
          {task.note ? (
            <Text color="gray">{"      "}{truncate(task.note, 100)}</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

// ── Agent activity line ────────────────────────────────────────────────

export interface AgentActivity {
  agentId: string;
  agentName: string;
  role: string;
  turnNumber: number;
  status: "running" | "done" | "failed";
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
  textBuffer: string;
  events: AgentEventEntry[];
}

export interface AgentEventEntry {
  id: number;
  text: string;
  kind: "status" | "tool" | "tool-result" | "command" | "file" | "error" | "thinking" | "permission";
}

const ROLE_COLORS: Record<string, string> = {
  Orchestrator: "magenta",
  Backend: "blue",
  Frontend: "green",
};
const LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? "cyan";
}

function eventColor(kind: AgentEventEntry["kind"]): string {
  switch (kind) {
    case "tool":
      return "yellow";
    case "tool-result":
      return "green";
    case "command":
      return "cyan";
    case "file":
      return "magenta";
    case "error":
      return "red";
    case "thinking":
      return "blue";
    case "permission":
      return "yellow";
    case "status":
    default:
      return "gray";
  }
}

function eventDim(kind: AgentEventEntry["kind"]): boolean {
  return kind === "status";
}

export function formatElapsedTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function loadingFrame(nowMs: number): string {
  return LOADING_FRAMES[Math.floor(nowMs / 80) % LOADING_FRAMES.length]!;
}

interface PanelLine {
  key: string;
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

function wrapText(text: string, width: number): string[] {
  const maxWidth = Math.max(12, width);
  const rawLines = text.split("\n");
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    const line = rawLine.trimEnd();
    if (!line) {
      wrapped.push("");
      continue;
    }

    let remaining = line;
    while (remaining.length > maxWidth) {
      const slice = remaining.slice(0, maxWidth + 1);
      const breakIndex = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\t"));
      const cut = breakIndex > maxWidth / 2 ? breakIndex : maxWidth;
      wrapped.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }

    wrapped.push(remaining);
  }

  return wrapped;
}

function wrapPanelLines(lines: PanelLine[], width: number): PanelLine[] {
  return lines.flatMap((line) =>
    wrapText(line.text, width).map((text, index) => ({
      ...line,
      key: `${line.key}-${index}`,
      text,
    }))
  );
}

function viewportSlice(lines: PanelLine[], offset: number, viewportLines: number): {
  visible: PanelLine[];
  safeOffset: number;
  maxOffset: number;
  startIndex: number;
} {
  const maxOffset = Math.max(0, lines.length - viewportLines);
  const safeOffset = Math.min(Math.max(0, offset), maxOffset);
  const startIndex = Math.max(0, lines.length - viewportLines - safeOffset);
  return {
    visible: lines.slice(startIndex, startIndex + viewportLines),
    safeOffset,
    maxOffset,
    startIndex,
  };
}

function PanelFrame({
  title,
  titleColor,
  subtitle,
  lines,
  width,
  viewportLines,
  scrollOffset,
  focused,
  showBottomBorder = true,
  showRightBorder = true,
}: {
  title: string;
  titleColor: string;
  subtitle?: string;
  lines: PanelLine[];
  width: number;
  viewportLines: number;
  scrollOffset: number;
  focused: boolean;
  showBottomBorder?: boolean;
  showRightBorder?: boolean;
}) {
  // Subtract 2 for left+right border, 2 for paddingX; skip right border/pad when hidden
  const contentWidth = width - (showRightBorder ? 4 : 3);
  const wrappedLines = wrapPanelLines(lines, contentWidth);
  const { visible, safeOffset, maxOffset, startIndex } = viewportSlice(
    wrappedLines,
    scrollOffset,
    viewportLines,
  );
  const footerText = maxOffset > 0
    ? `[${startIndex + 1}-${Math.min(startIndex + viewportLines, wrappedLines.length)}/${wrappedLines.length}]${safeOffset === 0 ? " · tail" : ` · -${safeOffset}`}`
    : `[${wrappedLines.length}/${wrappedLines.length}]`;

  // Height: title(1) + content(viewportLines) + footer(1) + top border(1) + bottom border(0|1)
  const boxHeight = viewportLines + (showBottomBorder ? 4 : 3);

  return (
    <Box
      borderStyle="single"
      borderColor={focused ? "white" : "gray"}
      borderBottom={showBottomBorder}
      borderRight={showRightBorder}
      paddingLeft={1}
      paddingRight={showRightBorder ? 1 : 0}
      flexDirection="column"
      width={width}
      height={boxHeight}
    >
      <Text>
        <Text color={titleColor} bold>{title}</Text>
        {subtitle ? <Text color="gray"> · {subtitle}</Text> : null}
      </Text>
      <Box flexDirection="column">
        {visible.map((line) => (
          <Text key={line.key} color={line.color} dimColor={line.dimColor} bold={line.bold}>
            {line.text || " "}
          </Text>
        ))}
        {Array.from({ length: Math.max(0, viewportLines - visible.length) }, (_, index) => (
          <Text key={`blank-${index}`}> </Text>
        ))}
      </Box>
      <Text color={focused ? "white" : "gray"} dimColor={!focused}>
        {footerText}{focused ? " · focus" : ""}
      </Text>
    </Box>
  );
}

export function MemberPanel({
  member,
  activity,
  allActivities,
  nowMs,
  width,
  viewportLines,
  scrollOffset,
  focused,
  showBottomBorder = true,
  showRightBorder = true,
}: {
  member: TeamMemberDefinition;
  activity?: AgentActivity;
  allActivities?: AgentActivity[];
  nowMs: number;
  width: number;
  viewportLines: number;
  scrollOffset: number;
  focused: boolean;
  showBottomBorder?: boolean;
  showRightBorder?: boolean;
}) {
  const accent = roleColor(member.role);
  const status = activity?.status ?? "idle";
  const isRunning = status === "running";

  // Compute cumulative working time across all turns for this agent
  const cumulativeMs = (allActivities ?? (activity ? [activity] : [])).reduce((sum, a) => {
    const end = a.completedAt ?? (a.status === "running" ? nowMs : a.startedAt);
    return sum + (end - a.startedAt);
  }, 0);
  const totalLabel = cumulativeMs > 0 ? formatElapsedTime(cumulativeMs) : undefined;

  const spinner = isRunning ? loadingFrame(nowMs) : undefined;
  const statusLabel = status === "idle"
    ? "waiting"
    : status === "running"
      ? `${spinner} ${totalLabel ?? "0s"} · turn ${activity?.turnNumber ?? "?"}`
      : status === "failed"
        ? `failed · ${totalLabel ?? "0s"} · turn ${activity?.turnNumber ?? "?"}`
        : `done · ${totalLabel ?? "0s"} · turn ${activity?.turnNumber ?? "?"}`;
  const lines: PanelLine[] = [];

  const recentEvents = activity?.events.slice(-16) ?? [];
  for (const entry of recentEvents) {
    lines.push({
      key: `event-${entry.id}`,
      text: `${kindIcon(entry.kind)} ${entry.text}`,
      color: eventColor(entry.kind),
      dimColor: eventDim(entry.kind),
    });
  }

  if (activity?.textBuffer) {
    const visibleText = truncateLines(activity.textBuffer, isRunning ? 40 : 16).split("\n");
    for (const [index, text] of visibleText.entries()) {
      lines.push({
        key: `live-${index}`,
        text,
        color: "white",
        dimColor: !isRunning,
      });
    }
  }

  if (activity?.summary && !isRunning) {
    lines.push({ key: "summary", text: activity.summary, color: "white" });
  }

  if (activity?.error) {
    lines.push({ key: "error", text: activity.error, color: "red" });
  }

  if (!activity) {
    lines.push({ key: "empty", text: "No activity yet.", color: "gray", dimColor: true });
  }

  return (
    <PanelFrame
      title={`${member.name} (${member.role})`}
      titleColor={accent}
      subtitle={[member.provider, member.model, statusLabel].filter(Boolean).join(" · ")}
      lines={lines}
      width={width}
      viewportLines={viewportLines}
      scrollOffset={scrollOffset}
      focused={focused}
      showBottomBorder={showBottomBorder}
      showRightBorder={showRightBorder}
    />
  );
}

// ── Message feed ───────────────────────────────────────────────────────

export function MessageEntry({ message }: { message: TeamMessage }) {
  const kindColor =
    message.kind === "task"
      ? "yellow"
      : message.kind === "question"
        ? "blue"
        : message.kind === "answer"
          ? "green"
          : "gray";

  const payloadHints = formatPayloadHints(message.payload);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="gray">{"  "}</Text>
        <Text color={kindColor}>{message.kind}</Text>
        <Text color="gray">
          {" "}
          {message.from} → {message.to}
        </Text>
        <Text color="white">: {truncate(message.text, 100)}</Text>
      </Text>
      {payloadHints ? (
        <Text color="gray" dimColor>{"    "}{payloadHints}</Text>
      ) : null}
    </Box>
  );
}

function formatPayloadHints(payload: TeamMessage["payload"]): string | null {
  if (!payload) {
    return null;
  }

  const parts: string[] = [];

  if (payload.priority) {
    const icon = payload.priority === "high" ? "!" : payload.priority === "medium" ? "~" : "-";
    parts.push(`${icon}${payload.priority}`);
  }

  if (payload.files && payload.files.length > 0) {
    const filesSummary = payload.files.length <= 2
      ? payload.files.join(", ")
      : `${payload.files[0]}, +${payload.files.length - 1} more`;
    parts.push(`files: ${filesSummary}`);
  }

  if (payload.dependencies && payload.dependencies.length > 0) {
    parts.push(`deps: ${payload.dependencies.join(", ")}`);
  }

  if (payload.acceptanceCriteria && payload.acceptanceCriteria.length > 0) {
    parts.push(`${payload.acceptanceCriteria.length} acceptance criteria`);
  }

  if (payload.context && Object.keys(payload.context).length > 0) {
    parts.push(`context: {${Object.keys(payload.context).join(", ")}}`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

export function MessageFeed({
  messages,
  limit = 8,
}: {
  messages: TeamMessage[];
  limit?: number;
}) {
  const visible = messages.slice(-limit);
  if (visible.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="white" bold>
        Messages
      </Text>
      {visible.map((msg) => (
        <MessageEntry key={msg.id} message={msg} />
      ))}
      {messages.length > limit ? (
        <Text color="gray">
          {"  "}... {messages.length - limit} earlier messages
        </Text>
      ) : null}
    </Box>
  );
}

export function GroupChatPanel({
  messages,
  limit = 10,
  memberNames,
  width,
  viewportLines,
  scrollOffset,
  focused,
  showBottomBorder = true,
  showRightBorder = true,
}: {
  messages: TeamMessage[];
  limit?: number;
  memberNames?: Record<string, string>;
  width: number;
  viewportLines: number;
  scrollOffset: number;
  focused: boolean;
  showBottomBorder?: boolean;
  showRightBorder?: boolean;
}) {
  const visible = messages.slice(-limit);
  const lines: PanelLine[] = visible.length === 0
    ? [{ key: "empty", text: "No messages yet.", color: "gray", dimColor: true }]
    : visible.flatMap((message, index) =>
      formatMessageBlock(message, memberNames, index < visible.length - 1),
    );

  return (
    <PanelFrame
      title="Group Chat"
      titleColor="yellow"
      subtitle="messages and broadcasts"
      lines={lines}
      width={width}
      viewportLines={viewportLines}
      scrollOffset={scrollOffset}
      focused={focused}
      showBottomBorder={showBottomBorder}
      showRightBorder={showRightBorder}
    />
  );
}

function formatMessageBlock(
  message: TeamMessage,
  memberNames: Record<string, string> | undefined,
  includeSpacer: boolean,
): PanelLine[] {
  const lines: PanelLine[] = [
    {
      key: `${message.id}-header`,
      text: `${messageKindLabel(message.kind)}  ${displayActor(message.from, memberNames)} → ${displayActor(message.to, memberNames)}`,
      color: messageKindColor(message.kind),
      bold: true,
    },
  ];

  for (const [index, text] of formatMarkdownishLines(message.text).entries()) {
    lines.push({
      key: `${message.id}-body-${index}`,
      text,
      color: "white",
    });
  }

  if (message.taskIds.length > 0) {
    lines.push({
      key: `${message.id}-tasks`,
      text: `tasks: ${message.taskIds.join(", ")}`,
      color: "cyan",
    });
  }

  for (const [index, text] of formatPayloadDetailLines(message.payload).entries()) {
    lines.push({
      key: `${message.id}-payload-${index}`,
      text,
      color: "gray",
      dimColor: true,
    });
  }

  if (includeSpacer) {
    lines.push({
      key: `${message.id}-spacer`,
      text: "",
      color: "gray",
      dimColor: true,
    });
  }

  return lines;
}

function messageKindColor(kind: TeamMessage["kind"]): string {
  switch (kind) {
    case "task":
      return "yellow";
    case "question":
      return "blue";
    case "answer":
      return "green";
    case "group":
      return "magenta";
    case "update":
    default:
      return "white";
  }
}

function messageKindLabel(kind: TeamMessage["kind"]): string {
  switch (kind) {
    case "task":
      return "[TASK]";
    case "question":
      return "[QUESTION]";
    case "answer":
      return "[ANSWER]";
    case "group":
      return "[GROUP]";
    case "update":
    default:
      return "[UPDATE]";
  }
}

function displayActor(
  actorId: string,
  memberNames: Record<string, string> | undefined,
): string {
  if (actorId === "group") {
    return "Group";
  }
  if (actorId === "user") {
    return "User";
  }
  if (actorId === "orchestrator") {
    return "Orchestrator";
  }
  return memberNames?.[actorId] ?? actorId;
}

function formatMarkdownishLines(text: string): string[] {
  const source = text.replace(/\r/g, "").trim();
  if (!source) {
    return ["(empty message)"];
  }

  const lines: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!trimmed) {
      if (lines[lines.length - 1] !== "") {
        lines.push("");
      }
      continue;
    }

    if (inCodeBlock) {
      lines.push(`  ${rawLine}`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      lines.push(`• ${trimmed.replace(/^[-*]\s+/, "")}`);
      continue;
    }

    lines.push(trimmed);
  }

  return lines.length > 0 ? lines : ["(empty message)"];
}

function formatPayloadDetailLines(payload: TeamMessage["payload"]): string[] {
  if (!payload) {
    return [];
  }

  const lines: string[] = [];

  if (payload.priority) {
    lines.push(`priority: ${payload.priority}`);
  }

  if (payload.files && payload.files.length > 0) {
    const files = payload.files.length <= 3
      ? payload.files.map(shortDisplayPath)
      : [...payload.files.slice(0, 3).map(shortDisplayPath), `+${payload.files.length - 3} more`];
    lines.push(`files: ${files.join(", ")}`);
  }

  if (payload.dependencies && payload.dependencies.length > 0) {
    lines.push(`depends on: ${payload.dependencies.join(", ")}`);
  }

  if (payload.acceptanceCriteria && payload.acceptanceCriteria.length > 0) {
    lines.push("acceptance:");
    for (const criterion of payload.acceptanceCriteria) {
      lines.push(`• ${criterion}`);
    }
  }

  if (payload.context && Object.keys(payload.context).length > 0) {
    lines.push(`context: ${Object.keys(payload.context).join(", ")}`);
  }

  return lines;
}

function shortDisplayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join("/");
}

// ── Run summary footer ─────────────────────────────────────────────────

export function RunFooter({
  stopReason,
  turns,
  blockedQuestion,
  activeAgents,
  idleTicks,
  maxIdleTurns,
  doneTaskCount,
  totalTaskCount,
  focusedPanelLabel,
  expandedView,
}: {
  stopReason?: string;
  turns: number;
  blockedQuestion?: string;
  activeAgents?: number;
  idleTicks?: number;
  maxIdleTurns?: number;
  doneTaskCount?: number;
  totalTaskCount?: number;
  focusedPanelLabel?: string;
  expandedView?: boolean;
}) {
  const navigationHint = `[ ] switch pane · j/k or ↑/↓ scroll · Ctrl+O ${expandedView ? "restore grid" : "full panel"} · ${stopReason ? "q exit" : "Ctrl+C stop"}`;

  if (!stopReason) {
    const parts = [`turn ${turns}`];
    if (activeAgents != null && activeAgents > 0) {
      parts.push(`${activeAgents} active`);
    }
    if (idleTicks != null && idleTicks > 0 && maxIdleTurns != null) {
      parts.push(`idle ${idleTicks}/${maxIdleTurns}`);
    }
    if (totalTaskCount != null && doneTaskCount != null) {
      parts.push(`tasks ${doneTaskCount}/${totalTaskCount}`);
    }
    if (focusedPanelLabel) {
      parts.push(`focus ${focusedPanelLabel}`);
    }

    return (
      <Text color="gray">
        {parts.join(" · ")} · {navigationHint}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={blockedQuestion ? "yellow" : "green"}>
        {blockedQuestion ? "blocked" : "complete"} · {stopReason} · turns {turns}
        {totalTaskCount != null && doneTaskCount != null ? ` · tasks ${doneTaskCount}/${totalTaskCount}` : ""}
        {focusedPanelLabel ? ` · focus ${focusedPanelLabel}` : ""}
      </Text>
      {blockedQuestion ? <Text color="yellow">{blockedQuestion}</Text> : null}
      <Text color="gray">{navigationHint}</Text>
    </Box>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return text;
  }
  return lines.slice(-maxLines).join("\n");
}

function kindIcon(
  kind: AgentEventEntry["kind"],
): string {
  switch (kind) {
    case "tool":
      return "▸";
    case "tool-result":
      return "◂";
    case "command":
      return "$";
    case "file":
      return "⟐";
    case "error":
      return "✗";
    case "thinking":
      return "…";
    case "permission":
      return "⚿";
    case "status":
    default:
      return "·";
  }
}
