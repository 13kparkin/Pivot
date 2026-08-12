import { RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export function DesktopUpdateCheckIcon({ isAnimating }: { readonly isAnimating: boolean }) {
  return <RefreshCwIcon className={cn("size-4", isAnimating && "animate-spin-once")} />;
}
