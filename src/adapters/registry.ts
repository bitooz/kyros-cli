import type { AdapterFactory, AdapterProvider } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { OpenCodeAdapter } from "./opencode.js";

const registry = new Map<AdapterProvider, AdapterFactory>();

export function registerAdapter(
  provider: AdapterProvider,
  factory: AdapterFactory,
): void {
  registry.set(provider, factory);
}

export function getAdapter(provider: AdapterProvider): AdapterFactory {
  const factory = registry.get(provider);
  if (!factory) {
    throw new Error(`No adapter registered for provider "${provider}".`);
  }
  return factory;
}

export function listAdapters(): AdapterProvider[] {
  return [...registry.keys()];
}

export function registerBuiltinAdapters(): void {
  registerAdapter("claudeCode", new ClaudeAdapter());
  registerAdapter("codex", new CodexAdapter());
  registerAdapter("opencode", new OpenCodeAdapter());
}
