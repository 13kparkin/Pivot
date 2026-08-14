import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  OmpCapabilitiesError,
  OmpCapabilitiesSnapshot,
  OmpCapabilityResource,
  OmpCapabilityScope,
  OmpCapabilityKind,
  OmpSettingsSurfaceEntry,
  OmpWriteSettingInput,
  ServerOmpCapabilitiesGetSnapshotInput,
  ServerOmpCapabilitiesResetSettingInput,
  ServerOmpCapabilitiesWriteSettingInput,
} from "./capabilities.ts";

const decodeResource = Schema.decodeUnknownSync(OmpCapabilityResource);
const encodeResource = Schema.encodeSync(OmpCapabilityResource);
const decodeSnapshot = Schema.decodeUnknownSync(OmpCapabilitiesSnapshot);
const decodeSettingsEntry = Schema.decodeUnknownSync(OmpSettingsSurfaceEntry);
const decodeWriteSetting = Schema.decodeUnknownSync(OmpWriteSettingInput);
const decodeGetSnapshot = Schema.decodeUnknownSync(ServerOmpCapabilitiesGetSnapshotInput);
const decodeWriteSettingTransport = Schema.decodeUnknownSync(
  ServerOmpCapabilitiesWriteSettingInput,
);
const decodeResetSettingTransport = Schema.decodeUnknownSync(
  ServerOmpCapabilitiesResetSettingInput,
);
const decodeError = Schema.decodeUnknownSync(OmpCapabilitiesError);

describe("OmpCapabilityScope", () => {
  it("accepts the three scopes", () => {
    expect(OmpCapabilityScope.literals).toEqual(["global", "project", "profile"]);
  });
});

describe("OmpCapabilityKind", () => {
  it("covers config, files, mcp, env", () => {
    expect(OmpCapabilityKind.literals).toEqual([
      "config",
      "models",
      "skills",
      "commands",
      "rules",
      "prompts",
      "instructions",
      "hooks",
      "tools",
      "extensions",
      "mcp",
      "env",
    ]);
  });
});

describe("OmpCapabilityResource", () => {
  it("round-trips a plain resource without host paths", () => {
    const resource = {
      kind: "config",
      name: "config.yml",
      scope: "global",
      provenance: "global",
      exists: true,
    } as const;
    expect(encodeResource(resource)).toEqual(resource);
    expect(decodeResource(resource)).toEqual(resource);
  });

  it("round-trips masked and hasValue metadata for write-only kinds", () => {
    const resource = {
      kind: "env",
      name: ".env",
      scope: "project",
      provenance: "project",
      exists: true,
      hasValue: true,
    } as const;
    expect(decodeResource(resource)).toEqual(resource);
  });

  it("accepts masked without hasValue", () => {
    const resource = {
      kind: "models",
      name: "models.yml",
      scope: "global",
      provenance: "global",
      exists: true,
      masked: true,
    } as const;
    expect(decodeResource(resource)).toEqual(resource);
  });
});

describe("OmpSettingsSurfaceEntry", () => {
  it("round-trips a set key with a value", () => {
    const entry = {
      key: "theme.dark",
      value: "titanium",
      type: "string",
      description: "Dark theme",
      masked: false,
      scope: "global",
    } as const;
    expect(decodeSettingsEntry(entry)).toEqual(entry);
  });

  it("omits value for unset keys (omp config list --json shape)", () => {
    const entry = {
      key: "auth.broker.token",
      type: "string",
      description: "",
      masked: true,
      scope: "global",
    } as const;
    const decoded = decodeSettingsEntry(entry);
    expect(decoded.value).toBeUndefined();
    expect(decoded.masked).toBe(true);
  });

  it("preserves non-string value types", () => {
    const entry = {
      key: "advisor.enabled",
      value: true,
      type: "boolean",
      description: "",
      masked: false,
      scope: "global",
    } as const;
    expect(decodeSettingsEntry(entry).value).toBe(true);
  });
});

describe("OmpCapabilitiesSnapshot", () => {
  it("decodes a full snapshot with resources and settings", () => {
    const snapshot = {
      agentDirLabel: "~/.omp/agent",
      settings: {
        entries: [
          {
            key: "theme.dark",
            value: "titanium",
            type: "string",
            description: "",
            masked: false,
            scope: "global",
          },
        ],
      },
      resources: [
        {
          kind: "skills",
          name: "skills",
          scope: "global",
          provenance: "global",
          exists: true,
        },
      ],
    } as const;
    expect(decodeSnapshot(snapshot).resources[0]?.name).toBe("skills");
  });

  it("decodes a snapshot without agentDirLabel (no absolute paths leaked)", () => {
    const snapshot = {
      settings: { entries: [] },
      resources: [],
    } as const;
    expect(decodeSnapshot(snapshot).agentDirLabel).toBeUndefined();
  });
});

describe("OmpWriteSettingInput", () => {
  it("round-trips a global write", () => {
    const input = { key: "theme.dark", value: "titanium", scope: "global" } as const;
    expect(decodeWriteSetting(input)).toEqual(input);
  });

  it("round-trips a project write with confirm", () => {
    const input = {
      key: "autoResume",
      value: true,
      scope: "project",
      projectId: ProjectId.make("project-1"),
      confirm: true,
    } as const;
    const decoded = decodeWriteSetting(input);
    expect(decoded.projectId).toBe("project-1");
    expect(decoded.confirm).toBe(true);
  });
});

describe("Server transport inputs", () => {
  it("routes getSnapshot by instanceId with optional projectId", () => {
    const input = {
      instanceId: ProviderInstanceId.make("omp"),
      projectId: ProjectId.make("p"),
    } as const;
    const decoded = decodeGetSnapshot(input);
    expect(decoded.instanceId).toBe("omp");
    expect(decoded.projectId).toBe("p");
  });

  it("accepts writeSetting transport without instanceId (defaults server-side)", () => {
    const decoded = decodeWriteSettingTransport({
      key: "autoResume",
      value: true,
      scope: "global",
    });
    expect(decoded.instanceId).toBeUndefined();
  });

  it("requires confirm for resetSetting", () => {
    const decoded = decodeResetSettingTransport({
      key: "autoResume",
      scope: "global",
      confirm: true,
    });
    expect(decoded.confirm).toBe(true);
  });
});

describe("OmpCapabilitiesError", () => {
  it("decodes with a reason", () => {
    const error = decodeError({
      _tag: "OmpCapabilitiesError",
      reason: "agent dir resolution failed",
    });
    expect(error.reason).toBe("agent dir resolution failed");
    expect(error.message).toBe("omp capabilities failed: agent dir resolution failed");
  });
});
