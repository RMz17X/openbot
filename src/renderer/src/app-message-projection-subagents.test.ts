import type { ConversationMessage, ConversationSubagent } from "@openbot/contracts/ipc";
import { CONVERSATION_SUBAGENTS_ITEM_TYPE } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { toAgentMessage } from "./app-message-projection";

/** A subagent that finished its work, as the read path carries it. */
function finishedSubagent(): ConversationSubagent {
  return {
    id: "call-1",
    title: "Read the release notes",
    agentType: null,
    prompt: "Read the release notes and summarize them",
    status: "completed",
    startedAt: "2026-11-13T00:00:00.000Z",
    endedAt: "2026-11-13T00:00:05.000Z",
    steps: [{ id: "call-1:result", kind: "text", text: "The release notes say the sync landed." }],
    error: null,
  };
}

/** A conversation message that carries the subagents of a turn. */
function subagentsMessage(): ConversationMessage {
  return {
    id: "message-1",
    author: "assistant",
    text: "The subagent finished the work.",
    createdAt: "2026-11-13T00:00:05.000Z",
    status: "completed",
    itemType: CONVERSATION_SUBAGENTS_ITEM_TYPE,
    subagents: [finishedSubagent()],
  };
}

/** A conversation message with nothing else in it. */
function plainMessage(): ConversationMessage {
  return {
    id: "message-2",
    author: "assistant",
    text: "A plain answer.",
    createdAt: "2026-11-13T00:00:05.000Z",
    status: "completed",
  };
}

/**
 * The last step of the Hermes subagent read path: the conversation message that carries the
 * subagents becomes a chat row of the kind `subagents`, which the dock and the timeline read.
 */
describe("the conversation subagent read path", () => {
  it("reads the subagents of a conversation message into a subagents row", () => {
    const row = toAgentMessage(subagentsMessage());
    expect(row.kind).toBe("subagents");
    expect(row.subagents).toHaveLength(1);
    expect(row.subagents?.[0]?.title).toBe("Read the release notes");
    expect(row.subagents?.[0]?.status).toBe("completed");
  });

  it("leaves a message without subagents alone", () => {
    const row = toAgentMessage(plainMessage());
    expect(row.kind).toBe("text");
    expect(row.subagents).toBeUndefined();
  });
});
