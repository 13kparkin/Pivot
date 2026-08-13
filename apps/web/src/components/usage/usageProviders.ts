import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, CursorIcon, type Icon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the other.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["omp"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  omp: "omp",
  claude: "Claude Code",
  codex: "Codex",
};

/** omp sky against Claude orange and Codex neutral. */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  omp: "#38bdf8",
  claude: "#d97757",
  codex: "#e6e6e6",
};

/**
 * Brand marks for the usage legend.
 *
 * omp has no dedicated mark in the picker yet; Cursor's mark stands in as the
 * host agent glyph until one ships.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  omp: CursorIcon,
  claude: ClaudeAI,
  codex: OpenAI,
};
