import { describe, expect, it } from "vite-plus/test";

import { buildFileLinkContextMenuItems } from "./fileLinkContextMenu";

describe("chat file link context menu", () => {
  it("puts Open in folder first when the environment supports it", () => {
    expect(
      buildFileLinkContextMenuItems({
        canRevealInFileManager: true,
        canOpenInBrowser: false,
      }),
    ).toEqual([
      { id: "open-in-folder", label: "Open in folder" },
      { id: "open", label: "Open in editor" },
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
  });

  it("hides Open in folder when the environment does not support it", () => {
    expect(
      buildFileLinkContextMenuItems({
        canRevealInFileManager: false,
        canOpenInBrowser: true,
      }),
    ).toEqual([
      { id: "open", label: "Open in editor" },
      { id: "open-in-browser", label: "Open in integrated browser" },
      { id: "copy-relative", label: "Copy relative path" },
      { id: "copy-full", label: "Copy full path" },
    ]);
  });
});
