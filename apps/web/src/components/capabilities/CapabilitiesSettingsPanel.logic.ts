import type { OmpCapabilityScope, OmpSettingsSurfaceEntry, ProjectId } from "@t3tools/contracts";

/**
 * Where an omp setting value may come from, least to most specific. The
 * ladder label explains which layer wins for the selected scope.
 */
export const PRECEDENCE_LADDER = ["defaults", "global", "project", "overlays", "runtime"] as const;

const PROJECT_LADDER_LABEL = "Effective: defaults <- global <- project <- overlays <- runtime";
const GLOBAL_LADDER_LABEL = "Effective: defaults <- global <- overlays <- runtime";

export function buildPrecedenceLabel(scope: OmpCapabilityScope): string {
  return scope === "project" ? PROJECT_LADDER_LABEL : GLOBAL_LADDER_LABEL;
}

export interface SettingsRow extends OmpSettingsSurfaceEntry {
  readonly displayValue: string;
}

export function buildSettingRows(
  entries: ReadonlyArray<OmpSettingsSurfaceEntry>,
): ReadonlyArray<SettingsRow> {
  return entries.map((entry) => ({
    ...entry,
    displayValue: entry.masked ? "********" : String(entry.value ?? ""),
  }));
}

export interface WriteSettingInput {
  readonly key: string;
  readonly value: unknown;
  readonly scope: OmpCapabilityScope;
  readonly projectId?: ProjectId;
}

/**
 * Shape the write payload for the wire: `projectId` is only legal for
 * project-scoped writes, so it is omitted when no project is resolved.
 */
export function buildWriteSettingInput(input: {
  readonly key: string;
  readonly value: unknown;
  readonly scope: OmpCapabilityScope;
  readonly projectId: ProjectId | null;
}): WriteSettingInput {
  return input.projectId === null
    ? { key: input.key, value: input.value, scope: input.scope }
    : { key: input.key, value: input.value, scope: input.scope, projectId: input.projectId };
}

/**
 * Masked entries (secrets) are write-only via their own flows — the settings
 * editor must not expose or edit their values.
 */
export function canEditEntry(entry: OmpSettingsSurfaceEntry): boolean {
  return !entry.masked;
}
