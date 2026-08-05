import type { ContextMenuItem } from "@t3tools/contracts";

export type FileLinkContextMenuAction =
  | "open-in-folder"
  | "open"
  | "open-in-browser"
  | "copy-relative"
  | "copy-full";

export function buildFileLinkContextMenuItems(input: {
  readonly canRevealInFileManager: boolean;
  readonly canOpenInBrowser: boolean;
}): readonly ContextMenuItem<FileLinkContextMenuAction>[] {
  return [
    ...(input.canRevealInFileManager
      ? ([{ id: "open-in-folder", label: "Open in folder" }] as const)
      : []),
    { id: "open", label: "Open in editor" },
    ...(input.canOpenInBrowser
      ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
      : []),
    { id: "copy-relative", label: "Copy relative path" },
    { id: "copy-full", label: "Copy full path" },
  ];
}
