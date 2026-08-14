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
