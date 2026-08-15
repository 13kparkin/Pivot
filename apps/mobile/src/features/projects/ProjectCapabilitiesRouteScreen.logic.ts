import type { ProjectGroup } from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentId,
  OmpCapabilityEditableKind,
  OmpCapabilityItem,
  OmpCapabilityItemName,
  OmpCapabilityScope,
  OmpDeleteResourceInput,
  OmpReadResourceInput,
  OmpResetSettingInput,
  OmpSettingsSurfaceEntry,
  OmpWriteResourceInput,
  OmpWriteSettingInput,
  ProjectId,
  ServerOmpCapabilitiesGetSnapshotInput,
} from "@t3tools/contracts";

/**
 * RPC input builders + item presentation for the mobile project capabilities
 * screen. Mirrors the web panels' logic (CapabilitiesSettingsPanel.logic +
 * CapabilityItemsPanel.logic) so project-scope writes always carry the
 * resolved projectId and global writes never do.
 */

/** Snapshot query target: projectId only when a project is resolved. */
export function buildCapabilitiesSnapshotInput(
  projectId: ProjectId | null,
): ServerOmpCapabilitiesGetSnapshotInput {
  return projectId === null ? {} : { projectId };
}

/**
 * Shape the setting-write payload for the wire: `projectId` is only legal
 * for project-scoped writes, so it is omitted when no project is resolved.
 */
export function buildWriteSettingInput(input: {
  readonly key: string;
  readonly value: unknown;
  readonly scope: OmpCapabilityScope;
  readonly projectId: ProjectId | null;
}): OmpWriteSettingInput {
  return input.projectId === null
    ? { key: input.key, value: input.value, scope: input.scope }
    : { key: input.key, value: input.value, scope: input.scope, projectId: input.projectId };
}

/** Destructive setting reset; the server requires `confirm: true` (D7). */
export function buildResetSettingInput(input: {
  readonly key: string;
  readonly scope: OmpCapabilityScope;
  readonly projectId: ProjectId | null;
}): OmpResetSettingInput {
  return input.projectId === null
    ? { key: input.key, scope: input.scope, confirm: true }
    : { key: input.key, scope: input.scope, projectId: input.projectId, confirm: true };
}

/** Read one rule/skill file; `projectId` only for project-scoped items. */
export function buildReadResourceInput(input: {
  readonly kind: OmpCapabilityEditableKind;
  readonly name: string;
  readonly scope: OmpCapabilityItem["scope"];
  readonly projectId: ProjectId | null;
}): OmpReadResourceInput {
  return input.projectId === null
    ? { kind: input.kind, name: input.name as OmpCapabilityItemName, scope: input.scope }
    : {
        kind: input.kind,
        name: input.name as OmpCapabilityItemName,
        scope: input.scope,
        projectId: input.projectId,
      };
}

/** Create or replace a rule/skill file; `overwrite` gates replacement (D7). */
export function buildWriteResourceInput(input: {
  readonly kind: OmpCapabilityEditableKind;
  readonly name: string;
  readonly content: string;
  readonly scope: OmpCapabilityItem["scope"];
  readonly projectId: ProjectId | null;
  readonly overwrite: boolean;
}): OmpWriteResourceInput {
  const base = {
    kind: input.kind,
    name: input.name as OmpCapabilityItemName,
    content: input.content,
    scope: input.scope,
    overwrite: input.overwrite,
  };
  return input.projectId === null ? base : { ...base, projectId: input.projectId };
}

/** Destructive rule/skill delete; the server requires `confirm: true` (D7). */
export function buildDeleteResourceInput(input: {
  readonly kind: OmpCapabilityEditableKind;
  readonly name: string;
  readonly scope: OmpCapabilityItem["scope"];
  readonly projectId: ProjectId | null;
}): OmpDeleteResourceInput {
  const base = {
    kind: input.kind,
    name: input.name as OmpCapabilityItemName,
    scope: input.scope,
    confirm: true,
  };
  return input.projectId === null ? base : { ...base, projectId: input.projectId };
}

export interface ProjectCapabilitiesSettingRow extends OmpSettingsSurfaceEntry {
  readonly displayValue: string;
}

/** Present settings rows; masked secrets render a fixed placeholder. */
export function buildSettingRows(
  entries: ReadonlyArray<OmpSettingsSurfaceEntry>,
): ReadonlyArray<ProjectCapabilitiesSettingRow> {
  return entries.map((entry) => ({
    ...entry,
    displayValue: entry.masked ? "********" : String(entry.value ?? ""),
  }));
}

/** Masked entries (secrets) are write-only via their own flows. */
export function canEditEntry(entry: OmpSettingsSurfaceEntry): boolean {
  return !entry.masked;
}

/** Display order: broadest scope first, then name. */
const SCOPE_ORDER: Readonly<Record<OmpCapabilityItem["scope"], number>> = {
  global: 0,
  project: 1,
};

/**
 * Keep only project-scoped items. The snapshot's skills/rules arrays still
 * carry global items; the project capabilities screen surfaces just the
 * project's own.
 */
export function projectScopeOnly(
  items: ReadonlyArray<OmpCapabilityItem>,
): ReadonlyArray<OmpCapabilityItem> {
  return items.filter((item) => item.scope === "project");
}

export interface ProjectCapabilityItemRow extends OmpCapabilityItem {
  readonly scopeLabel: string;
  /** Project item overriding a same-named global item (rules shadow, skills coexist). */
  readonly shadowed: boolean;
}

/**
 * Present rules/skills in display order (global first, then project) with
 * scope labels. A project item is flagged `shadowed` when a global item with
 * the same name exists — the project copy takes precedence for rules.
 */
export function buildCapabilityItemRows(
  items: ReadonlyArray<OmpCapabilityItem>,
): ReadonlyArray<ProjectCapabilityItemRow> {
  const globalNames = new Set(
    items.filter((item) => item.scope === "global").map((item) => item.name),
  );
  return items
    .map((item) => ({
      ...item,
      scopeLabel: item.scope === "global" ? "Global" : "Project",
      shadowed: item.scope === "project" && globalNames.has(item.name),
    }))
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.name.localeCompare(b.name));
}

/**
 * Slug pattern for rule/skill names. Mirrors the server-side contract
 * (`OmpCapabilityItemName`) so create-time validation fails in the UI
 * instead of on the wire.
 */
export const ITEM_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidItemName(name: string): boolean {
  return ITEM_NAME_PATTERN.test(name);
}

/** New-rule template. Rules load into every session; keep the guidance general. */
export const NEW_RULE_TEMPLATE = `---
description: "A rule that applies to every session."
---

Describe what the agent should do, and when.
`;

/** New-skill template. `{{name}}` is replaced with the item name on save. */
export const NEW_SKILL_TEMPLATE = `---
name: {{name}}
description: "A skill the agent can load when the task matches."
---

# {{name}}

Describe what this skill does and how to run it.
`;

/** Fill the skill template's name placeholder without touching user edits. */
export function withTemplateName(template: string, name: string): string {
  return template.replaceAll("{{name}}", name);
}

/**
 * Resolve which environment/project the gear's capabilities screen should
 * target for a logical project group: the group's member in the active
 * environment wins, otherwise the first member. Null when the group has no
 * members (cannot happen for real projects; guarded for synthetic groups).
 */
export function resolveProjectCapabilitiesTarget(
  group: ProjectGroup,
  preferredEnvironmentId: EnvironmentId | null,
): { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null {
  if (group.memberProjectRefs.length === 0) return null;
  const preferred =
    preferredEnvironmentId === null
      ? null
      : (group.memberProjectRefs.find((ref) => ref.environmentId === preferredEnvironmentId) ??
        null);
  const ref = preferred ?? group.memberProjectRefs[0]!;
  return { environmentId: ref.environmentId, projectId: ref.projectId };
}
