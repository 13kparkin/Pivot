import { describe, expect, it } from "vite-plus/test";

import {
  CAPABILITIES_SEARCH_ITEMS,
  searchCapabilities,
  type CapabilitiesSearchItem,
} from "./capabilitiesNav";

const ITEMS: ReadonlyArray<CapabilitiesSearchItem> = [
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
];

describe("searchCapabilities", () => {
  it("matches by title", () => {
    expect(searchCapabilities("overview", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-overview",
    ]);
    expect(searchCapabilities("settings", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-settings",
    ]);
  });

  it("matches by path substring", () => {
    expect(searchCapabilities("capabilities", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-overview",
      "capabilities-settings",
    ]);
    expect(searchCapabilities("/capabilities/settings", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-settings",
    ]);
  });

  it("returns all items for an empty query", () => {
    expect(searchCapabilities("", ITEMS)).toEqual(ITEMS);
    expect(searchCapabilities("   ", ITEMS)).toEqual(ITEMS);
  });

  it("returns no results when nothing matches", () => {
    expect(searchCapabilities("xyzzy", ITEMS)).toEqual([]);
    expect(searchCapabilities("claude", ITEMS)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchCapabilities("OVERVIEW", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-overview",
    ]);
    expect(searchCapabilities("  SeTtInGs  ", ITEMS).map((item) => item.id)).toEqual([
      "capabilities-settings",
    ]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = CAPABILITIES_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps catalog order for multiple matches", () => {
    expect(searchCapabilities("capabilities").map((item) => item.id)).toEqual([
      "capabilities-overview",
      "capabilities-settings",
    ]);
  });
});
