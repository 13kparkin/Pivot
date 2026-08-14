import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  type OmpCapabilityScope,
  type OmpSettingsSurfaceEntry,
} from "@t3tools/contracts";

import {
  buildPrecedenceLabel,
  buildSettingRows,
  buildWriteSettingInput,
  canEditEntry,
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

  it("renders unset values as an empty string", () => {
    const rows = buildSettingRows([entry({ key: "retries", value: undefined })]);
    expect(rows[0]!.displayValue).toBe("");
  });

  it("keeps the original entry fields", () => {
    const source = entry({ key: "theme.dark", type: "boolean", scope: "project" });
    const [row] = buildSettingRows([source]);
    expect(row).toMatchObject({ key: "theme.dark", type: "boolean", scope: "project" });
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
