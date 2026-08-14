import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["omp"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  omp: "omp",
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * omp's sky holds in both themes; Claude orange holds; Codex flips with the
 * theme or its bars vanish against the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  return {
    omp: "#38bdf8",
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
  };
}
