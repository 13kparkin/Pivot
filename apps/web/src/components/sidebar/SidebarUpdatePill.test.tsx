import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DesktopUpdateCheckIcon } from "./DesktopUpdateCheckIcon";

describe("DesktopUpdateCheckIcon", () => {
  it("keeps the refresh icon spinning while a fast update check settles", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateCheckIcon isAnimating />);

    expect(markup).toContain("animate-spin-once");
  });

  it("does not animate while idle", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateCheckIcon isAnimating={false} />);

    expect(markup).not.toContain("animate-spin-once");
  });
});
