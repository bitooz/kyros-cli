import type { AdapterProvider, QuestionRequest } from "../adapters/index.js";
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { createBufferState, type TextBufferState } from "./input.js";
import { MarkdownMessageView } from "./markdown.js";
import type {
  AccentColor,
  MessageRole,
  ModelPickerState,
  QuestionUiState,
  SessionPickerState,
  SlashCommand,
  UiActivity,
  UiMessage,
} from "./types.js";
import {
  formatCurrentModel,
  getQuestionSummaries,
  truncate,
} from "./utils.js";

function messagePrefix(role: MessageRole): string {
  switch (role) {
    case "user":
      return "❯";
    case "assistant":
      return "●";
    case "system":
    default:
      return "⬡";
  }
}

function messageColor(role: MessageRole): AccentColor | "gray" | "white" {
  switch (role) {
    case "user":
      return "white";
    case "assistant":
      return "white";
    case "system":
    default:
      return "gray";
  }
}

export function MessageView({ message, columns }: { message: UiMessage; columns?: number }) {
  if (message.role === "user") {
    const content = `${messagePrefix(message.role)} ${message.text}`;
    const pad = columns ? Math.max(0, columns - content.length) : 0;
    return (
      <Box flexDirection="column">
        <Text inverse color="white">{content}{" ".repeat(pad)}</Text>
      </Box>
    );
  }

  if (message.role === "assistant") {
    return <MarkdownMessageView text={message.text || (message.live ? "..." : "")} columns={columns} />;
  }

  return (
    <Box flexDirection="column">
      <Text color={messageColor(message.role)}>
        {messagePrefix(message.role)} {message.text || (message.live ? "..." : "")}
      </Text>
    </Box>
  );
}

export function ActivityView({ activity }: { activity: UiActivity }) {
  const isDone = activity.status === "done";
  const isFailed = activity.status === "failed";
  const dotColor = isDone ? "green" : (isFailed ? "red" : activity.accent);
  const statusText =
    activity.stats
    ?? (isFailed ? "Failed" : (isDone ? "Done" : (activity.status === "waiting" ? "Waiting..." : "Running...")));
  const titleColor = isDone ? "green" : (isFailed ? "red" : activity.accent);

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text>
        <Text color={dotColor}>{"● "}</Text>
        <Text color={titleColor} bold>{activity.title}</Text>
        {activity.subtitle ? <Text color="gray">{" "}{activity.subtitle}</Text> : null}
        <Text color="gray">{" "}{statusText}</Text>
      </Text>
      {activity.details.slice(-3).map((detail, index) => (
        <Text key={`${activity.id}-${index}`} color="gray">
          {"  \u2514 "}{detail}
        </Text>
      ))}
    </Box>
  );
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function ThinkingIndicator({ label, color = "magenta" }: { label: string; color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box>
      <Text color={color}>{SPINNER_FRAMES[frame]} {label}</Text>
      <Text color="gray"> (Esc to cancel)</Text>
    </Box>
  );
}

export function BufferTextView({
  buffer,
  placeholder,
  dimColor = false,
  showCursor = true,
}: {
  buffer: TextBufferState;
  placeholder?: string;
  dimColor?: boolean;
  showCursor?: boolean;
}) {
  if (!buffer.value && !showCursor) {
    return (
      <Text color="gray" dimColor={dimColor}>
        {placeholder ?? ""}
      </Text>
    );
  }

  const text = buffer.value || "";
  const lines = text.split("\n");
  let offset = 0;

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const lineStart = offset;
        const lineEnd = lineStart + line.length;
        const cursorOnLine = showCursor && buffer.cursor >= lineStart && buffer.cursor <= lineEnd;
        const cursorColumn = cursorOnLine ? buffer.cursor - lineStart : -1;
        const before = cursorOnLine ? line.slice(0, cursorColumn) : line;
        const atCursor = cursorOnLine
          ? (cursorColumn < line.length ? line[cursorColumn]! : " ")
          : "";
        const after = cursorOnLine
          ? line.slice(Math.min(cursorColumn + 1, line.length))
          : "";

        offset = lineEnd + 1;

        // Empty lines without cursor need a space to maintain height
        const isEmpty = !line && !cursorOnLine;

        return (
          <Text key={`buffer-line-${index}`} color="white" dimColor={dimColor}>
            {isEmpty ? " " : before}
            {cursorOnLine ? <Text inverse>{atCursor}</Text> : null}
            {after}
          </Text>
        );
      })}
    </Box>
  );
}

export function PromptEditor({
  buffer,
  placeholder,
  prefix = "❯",
  prefixColor = "cyan",
  showCursor = true,
  dimColor = false,
}: {
  buffer: TextBufferState;
  placeholder: string;
  prefix?: string;
  prefixColor?: string;
  showCursor?: boolean;
  dimColor?: boolean;
}) {
  const showPlaceholder = !buffer.value;
  return (
    <Box flexDirection="row">
      <Text color={prefixColor} dimColor={dimColor}>{prefix} </Text>
      <Box flexDirection="column" flexGrow={1}>
        {showPlaceholder ? (
          <Text dimColor={dimColor}>
            {showCursor ? <Text inverse>{" "}</Text> : null}
            <Text color="gray">{placeholder}</Text>
          </Text>
        ) : (
          <BufferTextView buffer={buffer} showCursor={showCursor} dimColor={dimColor} />
        )}
      </Box>
    </Box>
  );
}

export interface DocumentWorkflowStageView {
  key: string;
  fileName: string;
  approved: boolean;
  active: boolean;
  hasDraft: boolean;
}

export function DocumentWorkflowPanel({
  stages,
  currentFileName,
  complete,
  focus,
  canApprove,
  running,
  nextFileName,
}: {
  stages: DocumentWorkflowStageView[];
  currentFileName?: string;
  complete: boolean;
  focus: "approve" | "input";
  canApprove: boolean;
  running: boolean;
  nextFileName?: string;
}) {
  const actionColor = complete
    ? "green"
    : running
      ? "yellow"
      : canApprove && focus === "approve"
        ? "green"
        : "gray";

  return (
    <Box flexDirection="column">
      <Text>
        {stages.map((stage, index) => {
          const color = stage.approved
            ? "green"
            : (stage.active ? "yellow" : "gray");
          const prefix = stage.approved ? "✓ " : "";

          return (
            <Text key={stage.key} color={color}>
              {prefix}{stage.fileName}
              {index < stages.length - 1 ? <Text color="gray">{" -> "}</Text> : null}
            </Text>
          );
        })}
      </Text>
      {complete ? (
        <Text color={actionColor}>workflow complete</Text>
      ) : running ? (
        <Text color={actionColor}>generating {currentFileName}</Text>
      ) : canApprove ? (
        focus === "approve" ? (
          <Text color={actionColor}>
            enter approve
            {nextFileName ? <Text color="gray"> · next: {nextFileName}</Text> : null}
          </Text>
        ) : (
          <Text color={actionColor}>
            tab approve · <Text color="gray">enter sends edits</Text>
          </Text>
        )
      ) : (
        <Text color={actionColor}>
          enter describe {currentFileName}
        </Text>
      )}
    </Box>
  );
}

export function PromptModal({
  title,
  lines,
  accent,
}: {
  title: string;
  lines: string[];
  accent: AccentColor;
}) {
  return (
    <Box flexDirection="column">
      <Text color={accent} bold>{title}</Text>
      {lines.map((line, index) => (
        <Text key={`${title}-${index}`} color="white">{line}</Text>
      ))}
    </Box>
  );
}

export function QuestionModal({
  request,
  questionUi,
}: {
  request: QuestionRequest;
  questionUi: QuestionUiState;
}) {
  const submitFocused = questionUi.activeTab >= request.questions.length;
  const activeQuestionIndex = submitFocused ? 0 : questionUi.activeTab;
  const activeQuestion = request.questions[activeQuestionIndex]!;
  const draft = questionUi.drafts[activeQuestionIndex]!;
  const activeRow = questionUi.activeRowByQuestion[activeQuestionIndex] ?? 0;
  const summaries = getQuestionSummaries(request, questionUi.drafts);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">← </Text>
        {request.questions.map((question, index) => {
          const selected = questionUi.activeTab === index;
          return (
            <Text key={question.id} color={selected ? "white" : "gray"}>
              {selected ? "▣ " : "□ "}
              {question.header}
              <Text color="gray">  </Text>
            </Text>
          );
        })}
        <Text color={submitFocused ? "white" : "gray"}>
          {submitFocused ? "✓ " : "□ "}
          Submit
        </Text>
        <Text color="gray">  →</Text>
      </Box>

      {submitFocused ? (
        <Box flexDirection="column">
          <Text color="white" bold>Review answers</Text>
          {request.questions.map((question, index) => (
            <Text key={`summary-${question.id}`} color="gray">
              {index + 1}. {question.header}: <Text color="white">{summaries[index]}</Text>
            </Text>
          ))}
          <Text color="gray">Enter to submit · Shift+Tab/Tab to switch questions · Esc to cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color="blue" bold>{activeQuestion.question}</Text>
          {activeQuestion.options.map((option, index) => {
            const focused = activeRow === index;
            const selected = draft.selectedOptionIndexes.includes(index);
            const prefix = focused ? ">" : " ";
            const marker = activeQuestion.multiSelect
              ? (selected ? "[x]" : "[ ]")
              : (selected ? "●" : "○");

            return (
              <Box key={`${activeQuestion.id}-${option.label}`} flexDirection="column">
                <Text color={focused ? "white" : "gray"}>
                  {prefix} {index + 1}. {marker} {option.label}
                </Text>
                <Text color="gray">    {option.description}</Text>
                {focused && option.preview ? (
                  <Text color="cyan">    {truncate(option.preview, 140)}</Text>
                ) : null}
              </Box>
            );
          })}
          {activeQuestion.allowCustom !== false ? (
            <Box flexDirection="column">
              <Text color={activeRow === activeQuestion.options.length ? "white" : "gray"}>
                {activeRow === activeQuestion.options.length ? ">" : " "} {activeQuestion.options.length + 1}. {draft.customSelected ? "[x]" : "[ ]"} Type something
              </Text>
              <Box marginLeft={4}>
                <BufferTextView
                  buffer={createBufferState(draft.customValue, draft.customCursor)}
                  placeholder="Type a custom answer"
                  dimColor
                />
              </Box>
            </Box>
          ) : null}
          <Box>
            <Text color="gray">
              Enter to select · Tab/Shift+Tab to switch questions · Up/Down to navigate · Esc to cancel
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

export function CommandPalette({
  commands,
  selectedIndex,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
}) {
  if (commands.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray" dimColor> No matching commands.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {commands.slice(0, 8).map((command, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={command.name} color={selected ? "cyan" : "gray"} bold={selected} inverse={selected}>
            {selected ? " ❯ " : "   "}
            {command.name}
            {selected ? " " : ""}
            <Text color={selected ? "white" : "gray"} dimColor={!selected}> {command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function ModelPickerModal({
  provider,
  modelPicker,
}: {
  provider: AdapterProvider;
  modelPicker: ModelPickerState;
}) {
  // Filter options by search query
  const filtered = modelPicker.filter
    ? modelPicker.options.filter((o) => {
        const q = modelPicker.filter.toLowerCase();
        return o.label.toLowerCase().includes(q) || (o.value ?? "").toLowerCase().includes(q);
      })
    : modelPicker.options;

  const VIEWPORT_LINES = 12;
  const needsScroll = filtered.length > VIEWPORT_LINES;
  const contentSlots = needsScroll ? VIEWPORT_LINES : Math.min(filtered.length, VIEWPORT_LINES);

  const scrollStart = needsScroll
    ? Math.max(0, Math.min(modelPicker.selectedIndex - Math.floor(contentSlots / 2), filtered.length - contentSlots))
    : 0;
  const visibleItems = filtered.slice(scrollStart, scrollStart + contentSlots);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan" bold> Model</Text>
        {modelPicker.filter ? (
          <Text color="yellow"> /{modelPicker.filter}</Text>
        ) : (
          <Text color="gray" dimColor> type to search</Text>
        )}
      </Text>
      {modelPicker.loading ? <Text color="gray"> Loading...</Text> : null}
      {modelPicker.error ? <Text color="red"> {modelPicker.error}</Text> : null}
      {!modelPicker.loading && !modelPicker.customMode ? (
        <Box flexDirection="column">
          {visibleItems.length === 0 ? (
            <Text color="gray" dimColor>   No matches</Text>
          ) : null}
          {visibleItems.map((option, i) => {
            const idx = scrollStart + i;
            const selected = idx === modelPicker.selectedIndex;
            const current = option.isCurrent ? <Text color="green"> ✓</Text> : null;
            return (
              <Text key={option.key}>
                <Text color={selected ? "cyan" : "white"} bold={selected} inverse={selected}>
                  {selected ? " ❯ " : "   "}
                  {option.label}
                  {selected ? " " : ""}
                </Text>
                {current}
              </Text>
            );
          })}
        </Box>
      ) : null}
      {modelPicker.customMode ? (
        <>
          <Text color="white"> Enter a custom model value and press Enter.</Text>
          <Text color="gray" dimColor> Format: provider/model</Text>
        </>
      ) : null}
      <Text color="gray" dimColor>
        {modelPicker.customMode ? " Enter apply · Esc cancel" : " ↑↓ select · Enter · Esc"}
      </Text>
    </Box>
  );
}

export function SessionPickerModal({
  sessionPicker,
  formatTime,
}: {
  sessionPicker: SessionPickerState;
  formatTime: (ts: string) => string;
}) {
  const filtered = sessionPicker.filter
    ? sessionPicker.sessions.filter((s) => {
        const q = sessionPicker.filter.toLowerCase();
        return s.summary.toLowerCase().includes(q) || s.provider.toLowerCase().includes(q) || (s.model ?? "").toLowerCase().includes(q);
      })
    : sessionPicker.sessions;

  const VIEWPORT_LINES = 10;
  const needsScroll = filtered.length > VIEWPORT_LINES;
  const contentSlots = needsScroll ? VIEWPORT_LINES : Math.min(filtered.length, VIEWPORT_LINES);
  const scrollStart = needsScroll
    ? Math.max(0, Math.min(sessionPicker.selectedIndex - Math.floor(contentSlots / 2), filtered.length - contentSlots))
    : 0;
  const visibleItems = filtered.slice(scrollStart, scrollStart + contentSlots);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan" bold> Resume Session</Text>
        {sessionPicker.filter ? (
          <Text color="yellow"> /{sessionPicker.filter}</Text>
        ) : (
          <Text color="gray" dimColor> type to search</Text>
        )}
      </Text>
      {sessionPicker.loading ? <Text color="gray"> Loading sessions...</Text> : null}
      {sessionPicker.error ? <Text color="red"> {sessionPicker.error}</Text> : null}
      {!sessionPicker.loading && filtered.length === 0 && !sessionPicker.error ? (
        <Text color="gray" dimColor>   {sessionPicker.sessions.length === 0 ? "No saved sessions" : "No matches"}</Text>
      ) : null}
      {!sessionPicker.loading ? (
        <Box flexDirection="column">
          {visibleItems.map((session, i) => {
            const idx = scrollStart + i;
            const selected = idx === sessionPicker.selectedIndex;
            const preview = session.summary.length > 50 ? session.summary.slice(0, 47) + "..." : session.summary;
            return (
              <Text key={session.id}>
                <Text color={selected ? "cyan" : "white"} bold={selected} inverse={selected}>
                  {selected ? " ❯ " : "   "}
                  {preview}
                  {selected ? " " : ""}
                </Text>
                <Text color="gray" dimColor> {session.provider}{session.model ? `:${session.model}` : ""} · {formatTime(session.updatedAt)}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
      <Text color="gray" dimColor> ↑↓ select · Enter resume · Esc cancel</Text>
    </Box>
  );
}

export function Header({
  provider,
  currentModel,
  currentRunMode,
  currentPermissionMode,
}: {
  provider: AdapterProvider;
  currentModel: string | undefined;
  currentRunMode: string;
  currentPermissionMode: string;
}) {
  return (
    <Box flexDirection="column">
      <Text color="gray">
        <Text color="cyan" bold>kyros</Text>
        {" "}{provider}/{formatCurrentModel(provider, currentModel)}
        {" · "}{currentRunMode}/{currentPermissionMode}
      </Text>
    </Box>
  );
}
