import { describe, expect, it } from "vitest";
import { OpenCodeAdapterSession } from "../opencode.js";
import type { AdapterEvent, AdapterSessionConfig } from "../types.js";

describe("OpenCode adapter session", () => {
  it("completes when the prompt finishes even if session.idle never arrives", async () => {
    let subscribeSignal: AbortSignal | undefined;

    const client = {
      event: {
        subscribe: async (
          _parameters: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          subscribeSignal = options?.signal;
          return {
            stream: (async function* () {
              yield {
                type: "message.part.delta",
                properties: {
                  sessionID: "session-1",
                  messageID: "message-1",
                  partID: "part-1",
                  field: "text",
                  delta: "Partial ",
                },
              };

              await new Promise<void>((resolve) => {
                if (subscribeSignal?.aborted) {
                  resolve();
                  return;
                }

                subscribeSignal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            })(),
          };
        },
      },
      session: {
        prompt: async () => ({
          data: { ok: true },
          error: undefined,
        }),
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                tokens: {
                  input: 7,
                  output: 3,
                },
                cost: 0,
              },
              parts: [
                {
                  type: "text",
                  text: "Partial final answer",
                },
              ],
            },
          ],
        }),
        status: async () => ({
          data: {},
        }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      permission: {
        reply: async () => ({}),
      },
      question: {
        reject: async () => ({}),
        reply: async () => ({}),
      },
    } as const;

    const config: AdapterSessionConfig = {
      cwd: "/tmp",
    };
    const session = new OpenCodeAdapterSession(
      config,
      client as never,
      "session-1",
    );
    await session.send("hello");

    const events: AdapterEvent[] = [];
    for await (const event of session.stream()) {
      events.push(event);
    }

    expect(subscribeSignal?.aborted).toBe(true);
    expect(events[0]).toEqual({
      type: "session.started",
      provider: "opencode",
      sessionId: "session-1",
      model: undefined,
    });
    expect(events.some((event) => event.type === "text.delta" && event.text === "Partial ")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "completed",
      result: {
        provider: "opencode",
        sessionId: "session-1",
        text: "Partial final answer",
        usage: {
          inputTokens: 7,
          outputTokens: 3,
          costUsd: 0,
        },
        raw: { ok: true },
      },
    });
  });

  it("reports undici event stream termination as an adapter error", async () => {
    const client = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              type: "session.status",
              properties: {
                sessionID: "session-1",
                status: { type: "busy" },
              },
            };

            const cause = Object.assign(new Error("Body Timeout Error"), {
              code: "UND_ERR_BODY_TIMEOUT",
            });
            throw Object.assign(new TypeError("terminated"), { cause });
          })(),
        }),
      },
      session: {
        prompt: async () => ({
          data: { ok: true },
          error: undefined,
        }),
        messages: async () => ({
          data: [],
        }),
        status: async () => ({
          data: {},
        }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      permission: {
        reply: async () => ({}),
      },
      question: {
        reject: async () => ({}),
        reply: async () => ({}),
      },
    } as const;

    const session = new OpenCodeAdapterSession(
      { cwd: "/tmp" },
      client as never,
      "session-1",
    );
    await session.send("hello");

    const events: AdapterEvent[] = [];
    for await (const event of session.stream()) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "status" && event.message === "busy")).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "error",
      error: "terminated (UND_ERR_BODY_TIMEOUT). OpenCode event stream timed out before the turn completed.",
    });
  });

  it("streams current session.next events from OpenCode", async () => {
    const client = {
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              type: "session.next.step.started",
              properties: {
                sessionID: "session-1",
                timestamp: Date.now(),
                agent: "build",
                model: { providerID: "opencode", id: "test-model", variant: "standard" },
              },
            };
            yield {
              type: "session.next.text.delta",
              properties: {
                sessionID: "session-1",
                timestamp: Date.now(),
                delta: "Hello",
              },
            };
            yield {
              type: "session.next.tool.called",
              properties: {
                sessionID: "session-1",
                timestamp: Date.now(),
                callID: "call-1",
                tool: "read",
                input: { file: "src/index.ts" },
                provider: { executed: true },
              },
            };
            yield {
              type: "session.next.retried",
              properties: {
                sessionID: "session-1",
                timestamp: Date.now(),
                attempt: 1,
                error: {
                  message: "5 hour usage limit reached",
                  statusCode: 429,
                  isRetryable: true,
                  responseBody: "reset in 2 hours",
                },
              },
            };
            yield {
              type: "session.idle",
              properties: {
                sessionID: "session-1",
              },
            };
          })(),
        }),
      },
      session: {
        prompt: async () => ({
          data: { ok: true },
          error: undefined,
        }),
        messages: async () => ({
          data: [
            {
              info: {
                role: "assistant",
                tokens: { input: 1, output: 1 },
                cost: 0,
              },
              parts: [{ type: "text", text: "Hello" }],
            },
          ],
        }),
        status: async () => ({
          data: {},
        }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
      permission: {
        reply: async () => ({}),
      },
      question: {
        reject: async () => ({}),
        reply: async () => ({}),
      },
    } as const;

    const session = new OpenCodeAdapterSession(
      { cwd: "/tmp" },
      client as never,
      "session-1",
    );
    await session.send("hello");

    const events: AdapterEvent[] = [];
    for await (const event of session.stream()) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "status" && event.category === "step")).toBe(true);
    expect(events.some((event) => event.type === "text.delta" && event.text === "Hello")).toBe(true);
    expect(events.some((event) => event.type === "tool.use" && event.tool === "read")).toBe(true);
    expect(events.some((event) =>
      event.type === "error"
      && event.error.includes("5 hour usage limit reached")
      && event.error.includes("status 429")
    )).toBe(true);
  });

  it("surfaces retry status while waiting for provider events", async () => {
    const originalHeartbeat = process.env.KYROS_INK_OPENCODE_WAIT_HEARTBEAT_MS;
    process.env.KYROS_INK_OPENCODE_WAIT_HEARTBEAT_MS = "10";
    let subscribeSignal: AbortSignal | undefined;
    let statusCalls = 0;
    const client = {
      event: {
        subscribe: async (
          _parameters: unknown,
          options?: { signal?: AbortSignal },
        ) => {
          subscribeSignal = options?.signal;
          return {
            stream: (async function* () {
              await new Promise<void>((resolve) => {
                subscribeSignal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            })(),
          };
        },
      },
      session: {
        prompt: async () => ({
          data: { ok: true },
          error: undefined,
        }),
        messages: async () => ({
          data: [],
        }),
        status: async () => {
          statusCalls += 1;
          return {
            data: {
              "session-1": {
                type: "retry",
                attempt: 2,
                message: "5 hour usage limit reached",
                action: {
                  reason: "usage_limit",
                  provider: "opencode",
                  title: "Go limit reached",
                  message: "It will reset in 2 hours",
                  label: "open settings",
                  link: "https://opencode.ai/workspace/test",
                },
                next: 7_200_000,
              },
            },
          };
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
      permission: {
        reply: async () => ({}),
      },
      question: {
        reject: async () => ({}),
        reply: async () => ({}),
      },
    } as const;

    const session = new OpenCodeAdapterSession(
      { cwd: "/tmp" },
      client as never,
      "session-1",
    );
    await session.send("hello");

    try {
      const iterator = session.stream();
      const events: AdapterEvent[] = [];
      for (let i = 0; i < 6; i += 1) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        events.push(next.value);
        if (next.value.type === "error") {
          await session.interrupt();
          break;
        }
      }

      expect(statusCalls).toBeGreaterThan(0);
      expect(events.some((event) =>
        event.type === "error"
        && event.error.includes("Go limit reached")
        && event.error.includes("5 hour usage limit reached")
      )).toBe(true);
    } finally {
      if (originalHeartbeat === undefined) {
        delete process.env.KYROS_INK_OPENCODE_WAIT_HEARTBEAT_MS;
      } else {
        process.env.KYROS_INK_OPENCODE_WAIT_HEARTBEAT_MS = originalHeartbeat;
      }
    }
  });
});
