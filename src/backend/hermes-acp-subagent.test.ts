import { describe, expect, it } from "vitest";
import { HERMES_ACP_FLAVOR } from "./acp-flavor";
import { foldAcpSubagentTool } from "./agent/acp-subagent-updates";
import { newSubagentState, type SubagentState } from "./agent/subagent-updates";

/**
 * The Hermes ACP provider, from the tool call it makes to the card the chat shows.
 *
 * Hermes Agent answers a turn with `delegate_task` calls. The provider has no other way to
 * report a subagent: the subagent sends no events of its own, so the card is folded out of the
 * tool call. This test walks that path, from the flavor that names the tool to the change the
 * conversation read path reads.
 */
describe("the Hermes ACP provider and the conversation subagent read path", () => {
  it("names delegate_task as the tool that runs a subagent", () => {
    expect(HERMES_ACP_FLAVOR.subagentTools).toEqual(["delegate_task"]);
  });

  it("folds a Hermes delegate_task call into a subagent the chat can read", () => {
    const state: SubagentState = newSubagentState();

    // Hermes titles the call `delegate_task: <goal>`, so the title is the goal.
    const started = foldAcpSubagentTool(
      state,
      "turn-1",
      HERMES_ACP_FLAVOR.subagentTools ?? [],
      {
        id: "call-1",
        name: "delegate_task: Read the release notes",
        status: "in_progress",
        rawInput: { goal: "Read the release notes and summarize them" },
        rawOutput: undefined,
        content: undefined,
      },
      "2026-11-13T00:00:00.000Z",
    );
    expect(started).not.toBeNull();
    if (!started) return;

    expect(started.turnId).toBe("turn-1");
    expect(started.subagents).toHaveLength(1);
    const subagent = started.subagents[0];
    expect(subagent?.id).toBe("call-1");
    expect(subagent?.title).toBe("Read the release notes");
    expect(subagent?.prompt).toBe("Read the release notes and summarize them");
    expect(subagent?.status).toBe("running");
  });

  it("ends the subagent when the delegate_task call completes", () => {
    const state: SubagentState = newSubagentState();
    const names = HERMES_ACP_FLAVOR.subagentTools ?? [];

    const started = foldAcpSubagentTool(
      state,
      "turn-1",
      names,
      {
        id: "call-1",
        name: "delegate_task: Read the release notes",
        status: "in_progress",
        rawInput: { goal: "Read the release notes and summarize them" },
        rawOutput: undefined,
        content: undefined,
      },
      "2026-11-13T00:00:00.000Z",
    );
    expect(started).not.toBeNull();
    if (!started) return;

    const ended = foldAcpSubagentTool(
      state,
      "turn-1",
      names,
      {
        id: "call-1",
        name: "delegate_task: Read the release notes",
        status: "completed",
        rawInput: { goal: "Read the release notes and summarize them" },
        rawOutput: "The release notes say the sync landed.",
        content: undefined,
      },
      "2026-11-13T00:00:05.000Z",
    );
    expect(ended).not.toBeNull();
    if (!ended) return;

    const subagent = ended.subagents[0];
    expect(subagent?.status).toBe("completed");
    expect(subagent?.steps.at(-1)?.text).toBe("The release notes say the sync landed.");
  });

  it("explains a failed Hermes turn with its own message", () => {
    const detail = "Internal error: the turn ended early.";
    const redact = (text: string) => text;
    const log = () => {};
    const failed = HERMES_ACP_FLAVOR.turnFailure?.(
      { data: { details: "admitted_turn_failed" } },
      detail,
      redact,
      log,
      null,
      null,
    );
    expect(failed).not.toBe(detail);
    // A failure the protocol does not name keeps the detail it came with.
    expect(
      HERMES_ACP_FLAVOR.turnFailure?.({ data: { details: "something-else" } }, detail, redact, log, null, null),
    ).toBe(detail);
  });
});
