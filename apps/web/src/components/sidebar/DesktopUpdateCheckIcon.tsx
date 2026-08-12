import { RefreshCwIcon } from "lucide-react";
import type { AnimationEventHandler } from "react";

import { cn } from "../../lib/utils";

export function shouldContinueDesktopUpdateCheckAnimation({
  isChecking,
}: {
  readonly isChecking: boolean;
}) {
  return isChecking;
}

export function DesktopUpdateCheckIcon({
  isAnimating,
  onAnimationIteration,
}: {
  readonly isAnimating: boolean;
  readonly onAnimationIteration?: AnimationEventHandler<SVGSVGElement>;
}) {
  return (
    <RefreshCwIcon
      className={cn("size-4", isAnimating && "animate-spin")}
      onAnimationIteration={onAnimationIteration}
    />
  );
}
