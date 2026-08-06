import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type { ReactNode } from "react";
import { useColorScheme, View, type ViewStyle } from "react-native";

const SURFACE_STYLE: ViewStyle = {
  borderRadius: 20,
  overflow: "hidden",
};

export function PendingCardSurface(props: { readonly children: ReactNode }) {
  const isDarkMode = useColorScheme() === "dark";
  const content = <View className="gap-2.5 p-4">{props.children}</View>;

  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        effect="regular"
        interactive
        colorScheme={isDarkMode ? "dark" : "light"}
        style={SURFACE_STYLE}
      >
        {content}
      </LiquidGlassView>
    );
  }

  return (
    <View
      className="rounded-[20px] border border-neutral-200 bg-neutral-100 dark:border-white/6 dark:bg-neutral-900"
      style={SURFACE_STYLE}
    >
      {content}
    </View>
  );
}
