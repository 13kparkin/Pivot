import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("detectComposerTrigger", () => {
  it("detects slash command at the start of the prompt", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash command after other text on the line", () => {
    const text = "fix this /pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: "fix this ".length,
      rangeEnd: text.length,
    });
  });

  it("keeps /model as slash-model with no query", () => {
    const text = "/model";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model active while its argument is typed", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps /model active mid-line while its argument is typed", () => {
    const text = "switch /model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: "switch ".length,
      rangeEnd: text.length,
    });
  });

  it("detects $skill trigger after other text", () => {
    const text = "run $gh-fi";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "run ".length,
      rangeEnd: text.length,
    });
  });

  it("detects @path trigger after other text", () => {
    const text = "check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "check ".length,
      rangeEnd: text.length,
    });
  });

  it("does not trigger on a slash inside a word", () => {
    const text = "see https://example.com/foo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toBeNull();
  });
});
