import { describe, expect, it } from "vite-plus/test";

import { formatOmpTranscriptMessage } from "./AgentsPanel";

describe("formatOmpTranscriptMessage", () => {
  it("reads string content", () => {
    expect(formatOmpTranscriptMessage({ role: "assistant", content: "hello" })).toBe("hello");
  });

  it("joins text parts", () => {
    expect(
      formatOmpTranscriptMessage({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });
});
