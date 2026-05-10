import type { AdapterProvider } from "../adapters/index.js";
import { extractResponseJson, parseTeamConfig } from "../team/runtime.js";

export function extractDocumentDraft(text: string): string {
  const trimmed = text.trim();
  const fullyFencedMatch = trimmed.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fullyFencedMatch?.[1]) {
    return fullyFencedMatch[1].trim();
  }
  return trimmed;
}

export function normalizeDocumentDraft(
  stageKey: "goal" | "plan" | "spec" | "tasks" | "roles",
  text: string,
  cwd: string,
  defaultProvider?: AdapterProvider,
  options?: { requireModels?: boolean; requireDescriptions?: boolean },
): string {
  const draft = extractDocumentDraft(text);
  if (!draft) {
    return "";
  }

  if (stageKey !== "roles") {
    return draft;
  }

  const parsed = JSON.parse(extractResponseJson(draft)) as Record<string, unknown>;
  const normalizedRecord = normalizeRolesRecord(parsed, defaultProvider);
  const normalized = JSON.stringify(normalizedRecord, null, 2);
  parseTeamConfig(normalized, cwd, {
    requireModels: options?.requireModels,
    requireDescriptions: options?.requireDescriptions,
  });
  return normalized;
}

export function looksLikeStructuredDocumentDraft(
  stageKey: "goal" | "plan" | "spec" | "tasks" | "roles",
  text: string,
): boolean {
  const draft = extractDocumentDraft(text);
  if (!draft) {
    return false;
  }

  if (stageKey === "roles") {
    return draft.trim().startsWith("{");
  }

  if (stageKey === "tasks") {
    return /^#/m.test(draft) || /^\s*-\s*\[[ xX]\]/m.test(draft);
  }

  return /^#/m.test(draft);
}

export function looksLikeNarrativeDocumentSummary(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  if (!lowered) {
    return false;
  }

  return [
    "let me ",
    "i'll ",
    "i will ",
    "already exists",
    "has been written",
    "ready to proceed",
    "the file captures",
    "before generating",
    "before writing",
    "now i have",
  ].some((pattern) => lowered.includes(pattern));
}

export interface RolesModelSummary {
  provider: AdapterProvider;
  model?: string;
  members: string[];
}

export interface RolesMemberModelSummary {
  id: string;
  name: string;
  provider: AdapterProvider;
  model?: string;
  isOrchestrator: boolean;
}

export function summarizeRolesModels(
  text: string,
  cwd: string,
  defaultProvider?: AdapterProvider,
): RolesModelSummary[] {
  const record = parseRolesRecord(text, cwd, defaultProvider);
  const buckets = new Map<string, RolesModelSummary>();

  for (const member of getRolesMembers(record)) {
    const provider = member.provider as AdapterProvider;
    const model = typeof member.model === "string" ? member.model : undefined;
    const key = `${provider}:${model ?? ""}`;
    const bucket = buckets.get(key) ?? {
      provider,
      model,
      members: [],
    };
    bucket.members.push(typeof member.name === "string" ? member.name : "unknown");
    buckets.set(key, bucket);
  }

  return [...buckets.values()].sort((left, right) =>
    `${left.provider}:${left.model ?? ""}`.localeCompare(`${right.provider}:${right.model ?? ""}`),
  );
}

export function summarizeRolesMemberModels(
  text: string,
  cwd: string,
  defaultProvider?: AdapterProvider,
): RolesMemberModelSummary[] {
  const record = parseRolesRecord(text, cwd, defaultProvider);
  return getRolesMemberEntries(record).map(({ member, id, name, isOrchestrator }) => ({
    id,
    name,
    provider: member.provider as AdapterProvider,
    model: typeof member.model === "string" ? member.model : undefined,
    isOrchestrator,
  }));
}

export function setRolesProviderModel(
  text: string,
  cwd: string,
  defaultProvider: AdapterProvider | undefined,
  targetProvider: AdapterProvider,
  nextModel: string | undefined,
): { content: string; updatedMembers: string[] } {
  const record = parseRolesRecord(text, cwd, defaultProvider);
  const updatedMembers: string[] = [];

  for (const member of getRolesMembers(record)) {
    if (member.provider !== targetProvider) {
      continue;
    }

    if (nextModel) {
      member.model = nextModel;
    } else {
      delete member.model;
    }
    updatedMembers.push(typeof member.name === "string" ? member.name : "unknown");
  }

  const normalized = JSON.stringify(record, null, 2);
  parseTeamConfig(normalized, cwd);
  return {
    content: normalized,
    updatedMembers,
  };
}

export function setRolesMemberModel(
  text: string,
  cwd: string,
  defaultProvider: AdapterProvider | undefined,
  targetMember: string,
  nextModel: string | undefined,
): { content: string; updatedMembers: string[] } {
  const record = parseRolesRecord(text, cwd, defaultProvider);
  const entries = getRolesMemberEntries(record);
  const normalizedTarget = slugifyMemberKey(targetMember);
  const matched = entries.filter(({ id, name }) =>
    slugifyMemberKey(id) === normalizedTarget
    || slugifyMemberKey(name) === normalizedTarget,
  );

  if (matched.length === 0) {
    throw new Error(`No team member matches "${targetMember}".`);
  }

  for (const entry of matched) {
    if (nextModel) {
      entry.member.model = nextModel;
    } else {
      delete entry.member.model;
    }
  }

  const normalized = JSON.stringify(record, null, 2);
  parseTeamConfig(normalized, cwd);
  return {
    content: normalized,
    updatedMembers: matched.map(({ name }) => name),
  };
}

function normalizeRolesRecord(
  input: Record<string, unknown>,
  defaultProvider: AdapterProvider | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  if (isRecord(input.orchestrator)) {
    next.orchestrator = normalizeMemberRecord(input.orchestrator, defaultProvider);
  }

  if (Array.isArray(input.coworkers)) {
    next.coworkers = input.coworkers.map((entry) =>
      isRecord(entry)
        ? normalizeMemberRecord(entry, defaultProvider)
        : entry,
    );
  }

  if (isRecord(input.runtime)) {
    next.runtime = normalizeRuntimeRecord(input.runtime);
  }

  return next;
}

function parseRolesRecord(
  text: string,
  cwd: string,
  defaultProvider: AdapterProvider | undefined,
): Record<string, unknown> {
  const normalized = normalizeDocumentDraft("roles", text, cwd, defaultProvider);
  return JSON.parse(extractResponseJson(normalized)) as Record<string, unknown>;
}

function getRolesMembers(record: Record<string, unknown>): Array<Record<string, unknown>> {
  return getRolesMemberEntries(record).map((entry) => entry.member);
}

function normalizeMemberRecord(
  input: Record<string, unknown>,
  defaultProvider: AdapterProvider | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const name = typeof input.name === "string" ? input.name.trim() : undefined;
  const description = typeof input.description === "string"
    ? input.description.trim()
    : (typeof input.role === "string" ? input.role.trim() : undefined);
  const provider = typeof input.provider === "string"
    ? input.provider.trim()
    : defaultProvider;
  const model = typeof input.model === "string" ? input.model.trim() : undefined;

  if (name) {
    next.name = name;
  }
  if (description) {
    next.description = description;
  }
  if (provider) {
    next.provider = provider;
  }
  if (model) {
    next.model = model;
  }

  return next;
}

function getRolesMemberEntries(record: Record<string, unknown>): Array<{
  member: Record<string, unknown>;
  id: string;
  name: string;
  isOrchestrator: boolean;
}> {
  const members: Array<{
    member: Record<string, unknown>;
    id: string;
    name: string;
    isOrchestrator: boolean;
  }> = [];

  if (isRecord(record.orchestrator)) {
    const name = typeof record.orchestrator.name === "string" ? record.orchestrator.name : "orchestrator";
    members.push({
      member: record.orchestrator,
      id: typeof record.orchestrator.id === "string" ? record.orchestrator.id : slugifyMemberKey(name),
      name,
      isOrchestrator: true,
    });
  }

  if (Array.isArray(record.coworkers)) {
    for (const coworker of record.coworkers) {
      if (!isRecord(coworker)) {
        continue;
      }
      const name = typeof coworker.name === "string" ? coworker.name : "coworker";
      members.push({
        member: coworker,
        id: typeof coworker.id === "string" ? coworker.id : slugifyMemberKey(name),
        name,
        isOrchestrator: false,
      });
    }
  }

  return members;
}

function slugifyMemberKey(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "member";
}

function normalizeRuntimeRecord(input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  const maxConcurrentAgents =
    asFiniteNumber(input.maxConcurrentAgents)
    ?? asFiniteNumber(input.maxConcurrentCoworkers)
    ?? asFiniteNumber(input.parallelism);
  if (maxConcurrentAgents != null) {
    next.maxConcurrentAgents = maxConcurrentAgents;
  }

  const maxIdleTurns = asFiniteNumber(input.maxIdleTurns);
  if (maxIdleTurns != null) {
    next.maxIdleTurns = maxIdleTurns;
  }

  if (typeof input.stopWhenTasksComplete === "boolean") {
    next.stopWhenTasksComplete = input.stopWhenTasksComplete;
  }

  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
