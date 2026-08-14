export type CapabilitiesPath = "/capabilities" | "/capabilities/settings";

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
