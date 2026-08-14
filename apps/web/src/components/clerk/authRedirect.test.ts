import { describe, expect, it } from "vite-plus/test";

import { resolveClerkSignInProps } from "./authRedirect";

describe("resolveClerkSignInProps", () => {
  it("returns to the current browser URL on the web", () => {
    const href = "https://app.t3.codes/connect?state=state-1#details";
    expect(resolveClerkSignInProps(href, false)).toEqual({ forceRedirectUrl: href });
  });

  it("removes a Clerk virtual pathname and callback params while preserving the desktop route", () => {
    expect(
      resolveClerkSignInProps(
        "pivot://app/CLERK-ROUTER/VIRTUAL/sign-up?__clerk_status=complete#/settings/connections",
        true,
      ),
    ).toEqual({
      forceRedirectUrl: "pivot://app/#/settings/connections",
      signUpForceRedirectUrl: "pivot://app/#/settings/connections",
    });
  });

  it("preserves a clean development desktop route", () => {
    expect(resolveClerkSignInProps("pivot-dev://app/#/settings/general", true)).toEqual({
      forceRedirectUrl: "pivot-dev://app/#/settings/general",
      signUpForceRedirectUrl: "pivot-dev://app/#/settings/general",
    });
  });
});
