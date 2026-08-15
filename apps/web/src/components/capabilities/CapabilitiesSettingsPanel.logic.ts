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

/**
 * Render a raw omp config value as editable text. Strings/booleans/numbers
 * stringify verbatim; records and arrays serialize as JSON so the editor
 * round-trips exactly what `omp config set` parses (JSON for both), instead
 * of String() collapsing records into "[object Object]".
 */
export function formatSettingValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Parse a text draft back into a typed value for the wire, matching the
 * schema-driven parsing `omp config set` applies. `enum`/`string` are the
 * only types with no local validation — the omp binary validates enums and
 * rejects unknown values, which the server surfaces on write.
 */
export function parseSettingDraft(
  type: string,
  draft: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const trimmed = draft.trim();

  if (type === "number") {
    if (trimmed.length === 0) return { ok: false, error: "Enter a number." };
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return { ok: false, error: `Invalid number: ${draft}.` };
    return { ok: true, value };
  }

  if (type === "array") {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: `Invalid array JSON: ${draft}` };
    }
    if (!Array.isArray(value)) return { ok: false, error: `Invalid array JSON: ${draft}` };
    return { ok: true, value };
  }

  if (type === "record") {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { ok: false, error: `Invalid record JSON: ${draft}` };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `Invalid record JSON: ${draft}` };
    }
    return { ok: true, value };
  }

  return { ok: true, value: trimmed };
}

export interface SettingsRow extends OmpSettingsSurfaceEntry {
  readonly displayValue: string;
}

export function buildSettingRows(
  entries: ReadonlyArray<OmpSettingsSurfaceEntry>,
): ReadonlyArray<SettingsRow> {
  return entries.map((entry) => ({
    ...entry,
    displayValue: entry.masked ? "********" : formatSettingValue(entry.value),
  }));
}

/**
 * Filter settings rows by key, type, or description. An empty query returns
 * every row unchanged so the table never flashes empty while clearing.
 */
export function filterSettingRows(
  rows: ReadonlyArray<SettingsRow>,
  query: string,
): ReadonlyArray<SettingsRow> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.key.toLocaleLowerCase().includes(normalized) ||
      row.type.toLocaleLowerCase().includes(normalized) ||
      row.description.toLocaleLowerCase().includes(normalized),
  );
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
