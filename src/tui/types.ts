import type {
  AdapterModelOption,
  AdapterPermissionMode,
  AdapterProvider,
  AdapterQuestionMode,
  AdapterRunMode,
  PermissionDecision,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
} from "../adapters/index.js";

export type TuiOutputMode = "tui";
export type MessageRole = "user" | "assistant" | "system";
export type ActivityStatus = "running" | "done" | "failed" | "waiting";
export type AccentColor = "blue" | "cyan" | "green" | "magenta" | "red" | "yellow";

export interface TuiOptions {
  provider: AdapterProvider;
  cwd: string;
  model?: string;
  systemPrompt?: string;
  permissionMode: AdapterPermissionMode;
  runMode: AdapterRunMode;
  questionMode: AdapterQuestionMode;
  outputMode: TuiOutputMode;
  initialPrompt?: string;
  refreshModels?: boolean;
}

export interface RunTeamAction {
  type: "run-team";
  teamName?: string;
  model?: string;
  permissionMode: AdapterPermissionMode;
  runMode: AdapterRunMode;
  questionMode: AdapterQuestionMode;
}

export type TuiAction = RunTeamAction;

export interface TuiResult {
  action?: TuiAction;
}

export interface UiMessage {
  id: string;
  role: MessageRole;
  text: string;
  live?: boolean;
}

export interface UiActivity {
  id: string;
  title: string;
  subtitle?: string;
  status: ActivityStatus;
  details: string[];
  stats?: string;
  accent: AccentColor;
  updatedAt: number;
}

export interface ToolMeta {
  id: string;
  name: string;
  description?: string;
  subagentType?: string;
  activityId: string;
}

export interface PermissionPromptState {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export interface QuestionPromptState {
  request: QuestionRequest;
  resolve: (answer: QuestionAnswer | undefined) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export interface ModelPickerOption extends AdapterModelOption {
  key: string;
  provider?: string;
  isCurrent: boolean;
  isCustom?: boolean;
}

export interface ModelPickerState {
  options: ModelPickerOption[];
  selectedIndex: number;
  loading: boolean;
  customMode: boolean;
  filter: string;
  error?: string;
}

export interface QuestionDraftState {
  selectedOptionIndexes: number[];
  customSelected: boolean;
  customValue: string;
  customCursor: number;
}

export interface QuestionUiState {
  activeTab: number;
  activeRowByQuestion: number[];
  drafts: QuestionDraftState[];
}

export interface InteractionModeOption {
  label: string;
  permissionMode: AdapterPermissionMode;
  runMode: AdapterRunMode;
}

export interface FeedEntry {
  kind: "message" | "activity";
  id: string;
}

export interface SavedSession {
  id: string;
  provider: string;
  model?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  summary: string;
  messages: UiMessage[];
}

export interface SessionPickerState {
  sessions: SavedSession[];
  selectedIndex: number;
  loading: boolean;
  filter: string;
  error?: string;
}
