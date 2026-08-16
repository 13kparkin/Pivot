import type { ServerOmpAgentChatEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeAgentTranscriptEntries } from "./AgentChatView";

function message(id: string, text: string): ServerOmpAgentChatEntry {
  return { id, kind: "message", role: "assistant", text };
}

describe("mergeAgentTranscriptEntries", () => {
  it("appends cursor pages without duplicating entries", () => {
    expect(
      mergeAgentTranscriptEntries(
        [message("0:0", "first")],
        [message("0:0", "first"), message("10:0", "second")],
        false,
      ),
    ).toEqual([message("0:0", "first"), message("10:0", "second")]);
  });

  it("replaces stale entries after a transcript cursor reset", () => {
    expect(
      mergeAgentTranscriptEntries([message("0:0", "stale")], [message("0:0", "rewritten")], true),
    ).toEqual([message("0:0", "rewritten")]);
  });
});
