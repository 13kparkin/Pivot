/**
 * omp Capabilities — wire types for the omp config surface.
 *
 * Server-owned discovery and read/write of OMP configuration (settings via
 * `omp config`, capability files under the agent dir / project `.omp`).
 * Wire hygiene (D5): inputs carry `ProviderInstanceId` + optional `ProjectId`
 * only — never client-supplied paths; outputs carry scope/provenance and
 * relative resource identifiers, never absolute host paths. Secret values
 * (`models.yml` keys, `.env`, `!`-resolved fields, auth store) are masked or
 * reduced to `hasValue` metadata (D6).
 *
 * @module contracts/capabilities
 */

import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Where a capability is written / where it was found.
 */
export const OmpCapabilityScope = Schema.Literals(["global", "project", "profile"]);
export type OmpCapabilityScope = typeof OmpCapabilityScope.Type;

/**
 * Known OMP capability surface kinds. `env` and `models` are write-only:
 * raw contents never cross the wire (masked / `hasValue` metadata only).
 */
export const OmpCapabilityKind = Schema.Literals([
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
export type OmpCapabilityKind = typeof OmpCapabilityKind.Type;

/**
 * One discovered capability resource. `name` is a safe relative identifier
 * (e.g. `config.yml`, `skills`), never a host path. `masked` marks secret
 * content (value omitted); `hasValue` is the write-only presence signal for
 * `env`/auth-style kinds.
 */
export const OmpCapabilityResource = Schema.Struct({
  kind: OmpCapabilityKind,
  name: TrimmedNonEmptyString,
  scope: OmpCapabilityScope,
  provenance: OmpCapabilityScope,
  exists: Schema.Boolean,
  masked: Schema.optionalKey(Schema.Boolean),
  hasValue: Schema.optionalKey(Schema.Boolean),
});
export type OmpCapabilityResource = typeof OmpCapabilityResource.Type;

/**
 * One setting from `omp config list --json`. `value` is absent for unset
 * keys (the CLI omits it). Secret-typed keys carry `masked: true` and a
 * masked `value`.
 */
/**
 * Slug addressing one rule or skill item. Safe identifier only — no path
 * separators, no leading dots — so a client-supplied name can never escape
 * its capability directory (D5).
 */
export const OmpCapabilityItemName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
);
export type OmpCapabilityItemName = typeof OmpCapabilityItemName.Type;

/**
 * Where a rule/skill item is read or written. Profile scope is not supported
 * for item edits — the active agent dir is the profile dir when in a profile.
 */
export const OmpCapabilityItemScope = Schema.Literals(["global", "project"]);
export type OmpCapabilityItemScope = typeof OmpCapabilityItemScope.Type;

/** Kinds whose contents are editable as markdown files (rules, skills). */
export const OmpCapabilityEditableKind = Schema.Literals(["skills", "rules"]);
export type OmpCapabilityEditableKind = typeof OmpCapabilityEditableKind.Type;

/**
 * One discovered rule or skill. `name` is the safe slug (rule `foo` maps to
 * `rules/foo.md`; skill `foo` maps to `skills/foo/SKILL.md`). `description`
 * comes from the file frontmatter when present.
 */
export const OmpCapabilityItem = Schema.Struct({
  name: OmpCapabilityItemName,
  scope: OmpCapabilityItemScope,
  description: Schema.optionalKey(Schema.String),
});
export type OmpCapabilityItem = typeof OmpCapabilityItem.Type;

export const OmpSettingsSurfaceEntry = Schema.Struct({
  key: TrimmedNonEmptyString,
  value: Schema.optionalKey(Schema.Unknown),
  type: TrimmedNonEmptyString,
  description: Schema.String,
  masked: Schema.Boolean,
  scope: OmpCapabilityScope,
});
export type OmpSettingsSurfaceEntry = typeof OmpSettingsSurfaceEntry.Type;

export const OmpSettingsSurface = Schema.Struct({
  entries: Schema.Array(OmpSettingsSurfaceEntry),
});
export type OmpSettingsSurface = typeof OmpSettingsSurface.Type;

/**
 * Snapshot of the OMP config surface. `agentDirLabel` is display-only
 * (`~`-relative); absolute host paths never appear.
 */
export const OmpCapabilitiesSnapshot = Schema.Struct({
  agentDirLabel: Schema.optionalKey(Schema.String),
  settings: OmpSettingsSurface,
  resources: Schema.Array(OmpCapabilityResource),
  skills: Schema.Array(OmpCapabilityItem),
  rules: Schema.Array(OmpCapabilityItem),
});
export type OmpCapabilitiesSnapshot = typeof OmpCapabilitiesSnapshot.Type;

/**
 * Scoped setting write. `value` present → set; `projectId` only for
 * `scope: "project"` (server resolves the trusted cwd). `confirm` gates
 * destructive resets on the transport layer.
 */
export const OmpWriteSettingInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  value: Schema.optionalKey(Schema.Unknown),
  scope: OmpCapabilityScope,
  projectId: Schema.optionalKey(ProjectId),
  confirm: Schema.optionalKey(Schema.Boolean),
});
export type OmpWriteSettingInput = typeof OmpWriteSettingInput.Type;

/**
 * Destructive reset back to the omp default. `confirm: true` is required
 * by the server (D7).
 */
export const OmpResetSettingInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  scope: OmpCapabilityScope,
  projectId: Schema.optionalKey(ProjectId),
  confirm: Schema.Boolean,
});
export type OmpResetSettingInput = typeof OmpResetSettingInput.Type;

export class OmpCapabilitiesError extends Schema.TaggedErrorClass<OmpCapabilitiesError>()(
  "OmpCapabilitiesError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `omp capabilities failed: ${this.reason}`;
  }
}

/**
 * WS-boundary error for the capabilities surface. The service/registry errors
 * are mapped to this wrapper at the transport edge, mirroring `ServerOmpHubError`.
 */
export class ServerOmpCapabilitiesError extends Schema.TaggedErrorClass<ServerOmpCapabilitiesError>()(
  "ServerOmpCapabilitiesError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `omp capabilities failed: ${this.reason}`;
  }
}

// Transport (WS) schemas. `instanceId` is optional — the server falls back to
// the default omp instance like the other omp RPCs.

export const ServerOmpCapabilitiesGetSnapshotInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  projectId: Schema.optionalKey(ProjectId),
});
export type ServerOmpCapabilitiesGetSnapshotInput =
  typeof ServerOmpCapabilitiesGetSnapshotInput.Type;

export const ServerOmpCapabilitiesGetSnapshotResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type ServerOmpCapabilitiesGetSnapshotResult =
  typeof ServerOmpCapabilitiesGetSnapshotResult.Type;

export const ServerOmpCapabilitiesWriteSettingInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  ...OmpWriteSettingInput.fields,
});
export type ServerOmpCapabilitiesWriteSettingInput =
  typeof ServerOmpCapabilitiesWriteSettingInput.Type;

export const ServerOmpCapabilitiesWriteSettingResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type ServerOmpCapabilitiesWriteSettingResult =
  typeof ServerOmpCapabilitiesWriteSettingResult.Type;

export const ServerOmpCapabilitiesResetSettingInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  ...OmpResetSettingInput.fields,
});
export type ServerOmpCapabilitiesResetSettingInput =
  typeof ServerOmpCapabilitiesResetSettingInput.Type;

export const ServerOmpCapabilitiesResetSettingResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type ServerOmpCapabilitiesResetSettingResult =
  typeof ServerOmpCapabilitiesResetSettingResult.Type;

/**
 * Read one rule/skill file. `projectId` is required for `scope: "project"`
 * (the server resolves the trusted cwd, never a client path).
 */
export const OmpReadResourceInput = Schema.Struct({
  kind: OmpCapabilityEditableKind,
  name: OmpCapabilityItemName,
  scope: OmpCapabilityItemScope,
  projectId: Schema.optionalKey(ProjectId),
});
export type OmpReadResourceInput = typeof OmpReadResourceInput.Type;

export const OmpReadResourceResult = Schema.Struct({
  name: OmpCapabilityItemName,
  scope: OmpCapabilityItemScope,
  content: Schema.String,
  exists: Schema.Boolean,
});
export type OmpReadResourceResult = typeof OmpReadResourceResult.Type;

/**
 * Create or replace a rule/skill file. `overwrite: true` is required to
 * replace an existing item; new items must not collide (D7).
 */
export const OmpWriteResourceInput = Schema.Struct({
  kind: OmpCapabilityEditableKind,
  name: OmpCapabilityItemName,
  content: Schema.String,
  scope: OmpCapabilityItemScope,
  projectId: Schema.optionalKey(ProjectId),
  overwrite: Schema.Boolean,
});
export type OmpWriteResourceInput = typeof OmpWriteResourceInput.Type;

export const OmpWriteResourceResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type OmpWriteResourceResult = typeof OmpWriteResourceResult.Type;

/**
 * Destructive rule/skill delete (file for rules, directory for skills).
 * `confirm: true` is required by the server (D7).
 */
export const OmpDeleteResourceInput = Schema.Struct({
  kind: OmpCapabilityEditableKind,
  name: OmpCapabilityItemName,
  scope: OmpCapabilityItemScope,
  projectId: Schema.optionalKey(ProjectId),
  confirm: Schema.Boolean,
});
export type OmpDeleteResourceInput = typeof OmpDeleteResourceInput.Type;

export const OmpDeleteResourceResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type OmpDeleteResourceResult = typeof OmpDeleteResourceResult.Type;

// Transport (WS) schemas for rule/skill item I/O. `instanceId` is optional —
// the server falls back to the default omp instance like the other omp RPCs.

export const ServerOmpCapabilitiesReadResourceInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  ...OmpReadResourceInput.fields,
});
export type ServerOmpCapabilitiesReadResourceInput =
  typeof ServerOmpCapabilitiesReadResourceInput.Type;

export const ServerOmpCapabilitiesReadResourceResult = Schema.Struct({
  resource: OmpReadResourceResult,
});
export type ServerOmpCapabilitiesReadResourceResult =
  typeof ServerOmpCapabilitiesReadResourceResult.Type;

export const ServerOmpCapabilitiesWriteResourceInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  ...OmpWriteResourceInput.fields,
});
export type ServerOmpCapabilitiesWriteResourceInput =
  typeof ServerOmpCapabilitiesWriteResourceInput.Type;

export const ServerOmpCapabilitiesWriteResourceResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type ServerOmpCapabilitiesWriteResourceResult =
  typeof ServerOmpCapabilitiesWriteResourceResult.Type;

export const ServerOmpCapabilitiesDeleteResourceInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  ...OmpDeleteResourceInput.fields,
});
export type ServerOmpCapabilitiesDeleteResourceInput =
  typeof ServerOmpCapabilitiesDeleteResourceInput.Type;

export const ServerOmpCapabilitiesDeleteResourceResult = Schema.Struct({
  snapshot: OmpCapabilitiesSnapshot,
});
export type ServerOmpCapabilitiesDeleteResourceResult =
  typeof ServerOmpCapabilitiesDeleteResourceResult.Type;
