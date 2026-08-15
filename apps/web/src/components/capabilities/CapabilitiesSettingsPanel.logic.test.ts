import { describe, expect, it } from "vite-plus/test";
import { ProjectId, type OmpSettingsSurfaceEntry } from "@t3tools/contracts";

import {
  buildPrecedenceLabel,
  buildSettingRows,
  buildWriteSettingInput,
  canEditEntry,
  filterSettingRows,
  formatSettingValue,
  parseSettingDraft,
  PRECEDENCE_LADDER,
} from "./CapabilitiesSettingsPanel.logic";

describe("PRECEDENCE_LADDER", () => {
  it("covers defaults through runtime in resolution order", () => {
    expect(PRECEDENCE_LADDER).toEqual(["defaults", "global", "project", "overlays", "runtime"]);
  });
});

describe("buildPrecedenceLabel", () => {
  it("includes the project rung only for project scope", () => {
    expect(buildPrecedenceLabel("project")).toBe(
      "Effective: defaults <- global <- project <- overlays <- runtime",
    );
    expect(buildPrecedenceLabel("global")).toBe(
      "Effective: defaults <- global <- overlays <- runtime",
    );
  });

  it("treats profile scope like global", () => {
    expect(buildPrecedenceLabel("profile")).toBe(
      "Effective: defaults <- global <- overlays <- runtime",
    );
  });
});

function entry(overrides: Partial<OmpSettingsSurfaceEntry>): OmpSettingsSurfaceEntry {
  return {
    key: "theme.dark",
    value: undefined,
    type: "boolean",
    description: "Use the dark theme.",
    masked: false,
    scope: "global",
    ...overrides,
  };
}

describe("buildSettingRows", () => {
  it("masks values of masked entries", () => {
    const rows = buildSettingRows([entry({ key: "api.key", masked: true, value: "abc123" })]);
    expect(rows[0]!).toMatchObject({ key: "api.key", displayValue: "********" });
  });

  it("stringifies present values", () => {
    const rows = buildSettingRows([
      entry({ key: "retries", value: 3 }),
      entry({ key: "enabled", value: true }),
    ]);
    expect(rows.map((row) => row.displayValue)).toEqual(["3", "true"]);
  });

  it("serializes records and arrays as JSON instead of [object Object]", () => {
    const rows = buildSettingRows([
      entry({ key: "modelRoles", type: "record", value: { default: "openai/gpt-5" } }),
      entry({ key: "cycleOrder", type: "array", value: ["smol", "default", "slow"] }),
    ]);
    expect(rows.map((row) => row.displayValue)).toEqual([
      '{"default":"openai/gpt-5"}',
      '["smol","default","slow"]',
    ]);
  });

  it("renders unset values as an empty string", () => {
    const rows = buildSettingRows([entry({ key: "retries", value: undefined })]);
    expect(rows[0]!.displayValue).toBe("");
  });

  it("keeps the original entry fields", () => {
    const source = entry({ key: "theme.dark", type: "boolean", scope: "project" });
    const [row] = buildSettingRows([source]);
    expect(row).toMatchObject({ key: "theme.dark", type: "boolean", scope: "project" });
  });

  it("carries enum choices through to the row", () => {
    const source = entry({
      key: "symbolPreset",
      type: "enum",
      values: ["unicode", "nerd", "ascii"],
    });
    const [row] = buildSettingRows([source]);
    expect(row?.values).toEqual(["unicode", "nerd", "ascii"]);
  });
});

describe("formatSettingValue", () => {
  it("stringifies primitives and JSON-encodes structured values", () => {
    expect(formatSettingValue("titanium")).toBe("titanium");
    expect(formatSettingValue(true)).toBe("true");
    expect(formatSettingValue(3)).toBe("3");
    expect(formatSettingValue({ default: "x" })).toBe('{"default":"x"}');
    expect(formatSettingValue(["a", "b"])).toBe('["a","b"]');
    expect(formatSettingValue(undefined)).toBe("");
    expect(formatSettingValue(null)).toBe("");
  });
});

describe("parseSettingDraft", () => {
  it("parses finite numbers", () => {
    expect(parseSettingDraft("number", " 5 ")).toEqual({ ok: true, value: 5 });
    expect(parseSettingDraft("number", "abc").ok).toBe(false);
    expect(parseSettingDraft("number", "").ok).toBe(false);
  });

  it("parses JSON arrays", () => {
    expect(parseSettingDraft("array", '["a","b"]')).toEqual({ ok: true, value: ["a", "b"] });
    expect(parseSettingDraft("array", '"nope"').ok).toBe(false);
    expect(parseSettingDraft("array", "{").ok).toBe(false);
  });

  it("parses JSON records", () => {
    expect(parseSettingDraft("record", '{"default":"openai/gpt-5"}')).toEqual({
      ok: true,
      value: { default: "openai/gpt-5" },
    });
    expect(parseSettingDraft("record", "[]").ok).toBe(false);
    expect(parseSettingDraft("record", "not json").ok).toBe(false);
  });

  it("passes strings and enums through verbatim", () => {
    expect(parseSettingDraft("enum", "  auto ")).toEqual({ ok: true, value: "auto" });
    expect(parseSettingDraft("string", "titanium")).toEqual({ ok: true, value: "titanium" });
  });
});

describe("buildWriteSettingInput", () => {
  it("omits projectId when there is no project", () => {
    const input = buildWriteSettingInput({
      key: "theme.dark",
      value: true,
      scope: "global",
      projectId: null,
    });
    expect(input).toEqual({ key: "theme.dark", value: true, scope: "global" });
    expect("projectId" in input).toBe(false);
  });

  it("includes projectId for project-scoped writes", () => {
    const projectId = ProjectId.make("project-1");
    const input = buildWriteSettingInput({
      key: "agent.prompt",
      value: "be brief",
      scope: "project",
      projectId,
    });
    expect(input).toEqual({ key: "agent.prompt", value: "be brief", scope: "project", projectId });
  });
});

describe("canEditEntry", () => {
  it("rejects masked entries", () => {
    expect(canEditEntry(entry({ masked: true }))).toBe(false);
  });

  it("accepts unmasked entries", () => {
    expect(canEditEntry(entry({ masked: false }))).toBe(true);
    expect(canEditEntry(entry({ masked: false, value: undefined }))).toBe(true);
  });
});

describe("filterSettingRows", () => {
  const rows = buildSettingRows([
    {
      key: "theme.dark",
      value: "titanium",
      type: "string",
      description: "Dark theme",
      masked: false,
      scope: "global",
    },
    {
      key: "advisor.enabled",
      value: true,
      type: "boolean",
      description: "Run the advisor",
      masked: false,
      scope: "global",
    },
    {
      key: "auth.broker.token",
      type: "string",
      description: "Broker token",
      masked: true,
      scope: "global",
    },
  ]);

  it("returns every row for an empty query", () => {
    expect(filterSettingRows(rows, "")).toHaveLength(3);
    expect(filterSettingRows(rows, "   ")).toHaveLength(3);
  });

  it("matches by key", () => {
    expect(filterSettingRows(rows, "theme.dark").map((row) => row.key)).toEqual(["theme.dark"]);
  });

  it("matches by type", () => {
    expect(filterSettingRows(rows, "boolean").map((row) => row.key)).toEqual(["advisor.enabled"]);
  });

  it("matches by description", () => {
    expect(filterSettingRows(rows, "broker").map((row) => row.key)).toEqual(["auth.broker.token"]);
  });

  it("is case-insensitive and trims the query", () => {
    expect(filterSettingRows(rows, "  THEME.DARK  ").map((row) => row.key)).toEqual(["theme.dark"]);
  });

  it("returns no rows when nothing matches", () => {
    expect(filterSettingRows(rows, "xyzzy")).toEqual([]);
  });
});
