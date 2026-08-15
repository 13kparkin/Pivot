import type { OmpCapabilityItem } from "@t3tools/contracts";

/**
 * Slug pattern for rule/skill names. Mirrors the server-side contract
 * (`OmpCapabilityItemName`) so create-time validation fails in the UI
 * instead of on the wire.
 */
export const ITEM_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidItemName(name: string): boolean {
  return ITEM_NAME_PATTERN.test(name);
}

/** Display order: broadest scope first, then name. */
const SCOPE_ORDER: Readonly<Record<OmpCapabilityItem["scope"], number>> = {
  global: 0,
  project: 1,
};

export interface CapabilityItemRow extends OmpCapabilityItem {
  readonly scopeLabel: string;
  /** Project item overriding a same-named global item (rules shadow, skills coexist). */
  readonly shadowed: boolean;
}

/**
 * Present rules/skills in display order (global first, then project) with
 * scope labels. A project item is flagged `shadowed` when a global item with
 * the same name exists — the project copy takes precedence for rules.
 */
export function buildItemRows(
  items: ReadonlyArray<OmpCapabilityItem>,
): ReadonlyArray<CapabilityItemRow> {
  const globalNames = new Set(
    items.filter((item) => item.scope === "global").map((item) => item.name),
  );
  return items
    .map((item) => ({
      ...item,
      scopeLabel:
        item.scope === "global"
          ? "Global"
          : item.projectTitle !== undefined
            ? `Project · ${item.projectTitle}`
            : "Project",
      shadowed: item.scope === "project" && globalNames.has(item.name),
    }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        a.name.localeCompare(b.name) ||
        // All-projects snapshots can carry same-named items from different
        // projects; keep their order deterministic.
        (a.projectId ?? "").localeCompare(b.projectId ?? ""),
    );
}

/**
 * Filter rows by name or frontmatter description. An empty query returns
 * every row unchanged.
 */
export function filterItemRows(
  rows: ReadonlyArray<CapabilityItemRow>,
  query: string,
): ReadonlyArray<CapabilityItemRow> {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.name.toLocaleLowerCase().includes(normalized) ||
      (row.description ?? "").toLocaleLowerCase().includes(normalized),
  );
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
