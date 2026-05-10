import type { AdapterQuestionMode, AdapterRunMode } from "./types.js";

function runModeInstructions(runMode: AdapterRunMode | undefined): string {
  if (runMode === "plan") {
    return [
      "You are in planning mode.",
      "You may inspect, reason, and ask clarifying questions, but do not make file edits or destructive changes.",
      "Return a concrete implementation plan unless the user explicitly switches you back into execution mode.",
    ].join(" ");
  }

  return [
    "You are in execution mode.",
    "Carry the task through to completion, staying within the configured permission model.",
  ].join(" ");
}

function questionModeInstructions(
  questionMode: AdapterQuestionMode | undefined,
): string {
  switch (questionMode) {
    case "required":
      return "Ask clarifying questions whenever requirements are ambiguous or a critical decision is missing.";
    case "disabled":
      return "Do not ask clarifying questions. Make the best safe assumption and proceed.";
    case "auto":
    default:
      return "Ask clarifying questions only when they materially unblock the task or change the solution.";
  }
}

export function buildRuntimeInstructions(input: {
  runMode?: AdapterRunMode;
  questionMode?: AdapterQuestionMode;
}): string {
  return [runModeInstructions(input.runMode), questionModeInstructions(input.questionMode)]
    .filter(Boolean)
    .join("\n\n");
}

export function mergeSystemPrompt(input: {
  systemPrompt?: string;
  runMode?: AdapterRunMode;
  questionMode?: AdapterQuestionMode;
}): string {
  return [input.systemPrompt?.trim(), buildRuntimeInstructions(input).trim()]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}
