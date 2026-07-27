import type {
  ProviderDriverKind,
  SkillInventory,
  SkillInventoryInstallation,
} from "@t3tools/contracts";

/** Matches a POSIX or Windows home directory so paths can read as `~/...`. */
const HOME_DIRECTORY_PREFIX = /^(?:\/(?:home|Users)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/;

/**
 * Shortens a skill directory for display: home-relative, and elided to its last
 * few segments when deep. The full path stays available in the tooltip.
 */
export function formatSkillPath(path: string): string {
  const homeRelative = path.replace(HOME_DIRECTORY_PREFIX, "~");
  const segments = homeRelative.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 4) return homeRelative;
  return `…/${segments.slice(-3).join("/")}`;
}

export function filterSkillInventory(inventory: SkillInventory, query: string): SkillInventory {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return inventory;
  return {
    ...inventory,
    installations: inventory.installations.filter((skill) =>
      [skill.name, skill.description ?? "", skill.directoryPath, skill.harnessDisplayName].some(
        (value) => value.toLocaleLowerCase().includes(normalizedQuery),
      ),
    ),
  };
}

export interface SkillHarnessGroup {
  readonly key: string;
  readonly harness: ProviderDriverKind;
  readonly harnessDisplayName: string;
  /** Shared parent directory of every skill in the group, when they agree. */
  readonly rootPath: string | null;
  readonly skills: ReadonlyArray<SkillInventoryInstallation>;
}

/** Stable identity for a single installation, unique within an inventory. */
export function skillKey(skill: SkillInventoryInstallation): string {
  return `${skill.providerInstanceId}:${skill.directoryPath}`;
}

function parentDirectory(path: string): string {
  const parent = path.replace(/[/\\]+[^/\\]+[/\\]*$/, "");
  return parent || path;
}

/**
 * Buckets installations by the harness that owns them, preserving inventory
 * order so the explorer renders deterministically across refreshes.
 */
export function groupSkillsByHarness(
  installations: ReadonlyArray<SkillInventoryInstallation>,
): ReadonlyArray<SkillHarnessGroup> {
  const groups = new Map<string, SkillInventoryInstallation[]>();
  for (const skill of installations) {
    const key = `${skill.providerInstanceId}\0${skill.harnessDisplayName}`;
    const existing = groups.get(key);
    if (existing) existing.push(skill);
    else groups.set(key, [skill]);
  }
  return [...groups.entries()].map(([key, skills]) => {
    const roots = new Set(skills.map((skill) => parentDirectory(skill.directoryPath)));
    return {
      key,
      harness: skills[0]!.harness,
      harnessDisplayName: skills[0]?.harnessDisplayName ?? key,
      rootPath: roots.size === 1 ? ([...roots][0] ?? null) : null,
      skills,
    };
  });
}

/** Raw SKILL.md text ready to render, or `null` when the file has no content. */
export function skillContentForDisplay(content: string): string | null {
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}
