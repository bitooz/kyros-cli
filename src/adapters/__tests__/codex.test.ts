import { describe, expect, it } from "vitest";
import { collectCodexItemEvents } from "../codex.js";

describe("Codex adapter message mapping", () => {
  it("only emits message.completed when the agent message item is terminal", async () => {
    const itemTextState = new Map<string, string>();

    const startedEvents = await collectCodexItemEvents({
      id: "message-1",
      type: "agent_message",
      text: "Hello",
    }, "item.started", itemTextState);

    const updatedEvents = await collectCodexItemEvents({
      id: "message-1",
      type: "agent_message",
      text: "Hello world",
    }, "item.updated", itemTextState);

    const completedEvents = await collectCodexItemEvents({
      id: "message-1",
      type: "agent_message",
      text: "Hello world!",
    }, "item.completed", itemTextState);

    expect(startedEvents).toEqual([
      { type: "text.delta", text: "Hello" },
    ]);
    expect(updatedEvents).toEqual([
      { type: "text.delta", text: " world" },
    ]);
    expect(completedEvents).toEqual([
      { type: "text.delta", text: "!" },
      { type: "message.completed", text: "Hello world!" },
    ]);
  });

  it("synthetically splits terminal-only agent messages into deltas", async () => {
    const text = "Codex returned this entire response in a single terminal event, so the adapter needs to split it into multiple text deltas to keep the UI feeling live.";

    const events = await collectCodexItemEvents({
      id: "message-2",
      type: "agent_message",
      text,
    }, "item.completed");

    const deltas = events.flatMap((event) => event.type === "text.delta" ? [event.text] : []);

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(text);
    expect(events.at(-1)).toEqual({
      type: "message.completed",
      text,
    });
  });
});
