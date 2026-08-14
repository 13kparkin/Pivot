import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  LayoutAnimation: {
    configureNext: vi.fn(),
    Types: { easeInEaseOut: "easeInEaseOut" },
    Properties: { opacity: "opacity" },
  },
  Pressable: () => null,
  ScrollView: () => null,
  useColorScheme: () => "light",
  View: () => null,
  Text: () => null,
  TextInput: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: () => null },
  FadeIn: { duration: () => ({}) },
}));

vi.mock("expo-haptics", () => ({
  default: { selectionAsync: vi.fn() },
}));

vi.mock("../../components/AppSymbol", () => ({
  SymbolView: () => null,
}));

vi.mock("../../components/AppText", () => ({
  AppText: () => null,
}));

import { collapsedWorkLogHeight, visibleWorkLogActivities } from "./thread-work-log";
import type { ThreadFeedActivity } from "../../lib/threadActivity";

const BASE_FONT_SIZE = 16;

function feedActivity(
  overrides: Partial<ThreadFeedActivity> & { readonly id: string },
): ThreadFeedActivity {
  return {
    createdAt: "2026-04-01T00:00:01.000Z",
    turnId: null,
    summary: "Tool call",
    detail: null,
    canExpand: false,
    getFullDetail: () => null,
    getCopyText: () => overrides.id,
    icon: "zap",
    toolLike: true,
    status: "neutral",
    ...overrides,
  };
}

describe("visibleWorkLogActivities", () => {
  it("keeps advisor rows visible regardless of tone", () => {
    const rows = visibleWorkLogActivities([
      feedActivity({
        id: "advisor-concern",
        summary: "Consider extracting the helper",
        toolLike: false,
        status: null,
        icon: "warning",
      }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["advisor-concern"]);
  });

  it("keeps ttsr rows visible", () => {
    const rows = visibleWorkLogActivities([
      feedActivity({
        id: "ttsr-fired",
        summary: "Codegraph",
        toolLike: false,
        status: null,
        icon: "zap",
      }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["ttsr-fired"]);
  });

  it("hides neutral tool-like rows but keeps settled ones", () => {
    const rows = visibleWorkLogActivities([
      feedActivity({ id: "neutral-tool", status: "neutral" }),
      feedActivity({ id: "settled-tool", status: "success" }),
      feedActivity({ id: "failed-tool", status: "failure" }),
    ]);

    expect(rows.map((row) => row.id)).toEqual(["settled-tool", "failed-tool"]);
  });
});

describe("collapsedWorkLogHeight", () => {
  it("returns zero when no visible rows exist", () => {
    expect(collapsedWorkLogHeight([feedActivity({ id: "neutral-tool" })], BASE_FONT_SIZE)).toBe(0);
  });

  it("is deterministic for mixed advisor/tool rows", () => {
    const activities = [
      feedActivity({ id: "advisor", toolLike: false, status: null, icon: "warning" }),
      feedActivity({ id: "tool", status: "success" }),
      feedActivity({ id: "ttsr", toolLike: false, status: null, icon: "zap" }),
    ];

    const height = collapsedWorkLogHeight(activities, BASE_FONT_SIZE);
    expect(height).toBeGreaterThan(0);
    expect(Number.isFinite(height)).toBe(true);
    // Same input, same height: fixed pre-measurement stays deterministic.
    expect(collapsedWorkLogHeight(activities, BASE_FONT_SIZE)).toBe(height);
  });
});
