import type { OmpSettingsSurfaceEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelRolesFromSettingsEntries } from "./CapabilitiesModelsRolesPanel.logic";

function entry(overrides: Partial<OmpSettingsSurfaceEntry>): OmpSettingsSurfaceEntry {
  return {
    key: "x",
    type: "string",
    description: "",
    masked: false,
    scope: "global",
    ...overrides,
  } as OmpSettingsSurfaceEntry;
}

describe("modelRolesFromSettingsEntries", () => {
  it("reads roles from the record-valued modelRoles entry (global shape)", () => {
    const roles = modelRolesFromSettingsEntries([
      entry({
        key: "modelRoles",
        type: "record",
        value: { default: "cursor/cursor-grok-4.5-high", review: "openai/gpt-5.6" },
      }),
    ]);
    expect(roles).toEqual({
      default: "cursor/cursor-grok-4.5-high",
      review: "openai/gpt-5.6",
    });
  });

  it("reads roles from flattened modelRoles.<role> entries (project shape)", () => {
    const roles = modelRolesFromSettingsEntries([
      entry({ key: "modelRoles.default", type: "string", value: "cursor/cursor-grok-4.5-high" }),
      entry({ key: "modelRoles.review", type: "string", value: "openai/gpt-5.6" }),
    ]);
    expect(roles).toEqual({
      default: "cursor/cursor-grok-4.5-high",
      review: "openai/gpt-5.6",
    });
  });

  it("returns an empty map when modelRoles is absent", () => {
    expect(modelRolesFromSettingsEntries([entry({ key: "some.other" })])).toEqual({});
  });

  it("skips roles with empty or non-string values", () => {
    const roles = modelRolesFromSettingsEntries([
      entry({ key: "modelRoles.empty", type: "string", value: "" }),
      entry({ key: "modelRoles.record", type: "record", value: { nested: true } }),
    ]);
    expect(roles).toEqual({});
  });

  it("prefers the record entry over flattened keys when both are present", () => {
    const roles = modelRolesFromSettingsEntries([
      entry({ key: "modelRoles", type: "record", value: { default: "a", review: "b" } }),
      entry({ key: "modelRoles.review", type: "string", value: "stale" }),
    ]);
    expect(roles.review).toBe("b");
  });
});
