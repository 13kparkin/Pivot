import { describe, expect, it, vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));
vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { sanitizePreferences, type Preferences } from "./mobile-preferences";

describe("mobile preferences sanitize", () => {
  it("drops the legacy thread list opt-in key", () => {
    // Older OTA bundles may still store the removed key; sanitizing must
    // drop it instead of letting it survive in the preferences blob.
    expect(
      sanitizePreferences({
        legacyThreadListEnabled: true,
        liveActivitiesEnabled: false,
      } as Preferences),
    ).toEqual({ liveActivitiesEnabled: false });
  });

  it("keeps boolean-valued preference fields intact", () => {
    expect(
      sanitizePreferences({
        liveActivitiesEnabled: true,
        codeWordBreak: false,
      }),
    ).toEqual({ liveActivitiesEnabled: true, codeWordBreak: false });
  });
});
