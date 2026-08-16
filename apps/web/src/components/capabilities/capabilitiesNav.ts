export type CapabilitiesPath =
  | "/capabilities"
  | "/capabilities/settings"
  | "/capabilities/skills"
  | "/capabilities/rules"
  | "/capabilities/models-and-roles";

export interface CapabilitiesSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: CapabilitiesPath;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const CAPABILITIES_SECTION_LABELS: Readonly<Record<CapabilitiesPath, string>> = {
  "/capabilities": "Overview",
  "/capabilities/settings": "Settings",
  "/capabilities/skills": "Skills",
  "/capabilities/rules": "Rules",
  "/capabilities/models-and-roles": "Models & Roles",
};

/**
 * Every searchable capabilities destination, in result order. The sidebar
 * nav's section menu and search results both derive from this catalog.
 */
export const CAPABILITIES_SEARCH_ITEMS = [
  {
    id: "capabilities-overview",
    title: "Overview",
    to: "/capabilities",
  },
  {
    id: "capabilities-settings",
    title: "Settings",
    to: "/capabilities/settings",
  },
  {
    id: "capabilities-skills",
    title: "Skills",
    to: "/capabilities/skills",
  },
  {
    id: "capabilities-rules",
    title: "Rules",
    to: "/capabilities/rules",
  },
  {
    id: "capabilities-models-and-roles",
    title: "Models & Roles",
    to: "/capabilities/models-and-roles",
  },
] as const satisfies ReadonlyArray<CapabilitiesSearchItem>;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchCapabilities(
  query: string,
  items: ReadonlyArray<CapabilitiesSearchItem> = CAPABILITIES_SEARCH_ITEMS,
): ReadonlyArray<CapabilitiesSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return items;

  return items.filter(
    (item) =>
      normalizeSearchText(item.title).includes(normalizedQuery) ||
      normalizeSearchText(item.to).includes(normalizedQuery),
  );
}

/**
 * Search params shared by every /capabilities route: `projectKey` scopes
 * the surface to one logical project (the sidebar gear links here). Absent
 * means the global entry — first project in the active environment.
 */
export interface CapabilitiesSearch {
  readonly projectKey?: string;
}

export function validateCapabilitiesSearch(raw: Record<string, unknown>): CapabilitiesSearch {
  return typeof raw.projectKey === "string" && raw.projectKey
    ? { projectKey: raw.projectKey.slice(0, 200) }
    : {};
}
