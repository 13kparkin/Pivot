import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseOmpModelRoleSlug } from "./ompModelRoles.ts";

describe("parseOmpModelRoleSlug", () => {
  it("reads modelRoles.plan", () => {
    NodeAssert.equal(
      parseOmpModelRoleSlug(
        ["modelRoles:", "  default: openai/gpt-5", "  plan: anthropic/claude-plan"].join("\n"),
        "plan",
      ),
      "anthropic/claude-plan",
    );
  });

  it("returns undefined when the role is missing", () => {
    NodeAssert.equal(
      parseOmpModelRoleSlug(["modelRoles:", "  default: openai/gpt-5"].join("\n"), "plan"),
      undefined,
    );
  });
});
