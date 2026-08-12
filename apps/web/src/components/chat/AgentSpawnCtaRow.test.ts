import { describe, expect, it } from "vite-plus/test";

import { AGENT_SPAWN_CTA_CLASS_NAME } from "./MessagesTimeline";

describe("AgentSpawnCtaRow", () => {
  it("keeps both rounded ends inside the timeline viewport", () => {
    expect(AGENT_SPAWN_CTA_CLASS_NAME).not.toContain("-mx-1");
    expect(AGENT_SPAWN_CTA_CLASS_NAME).toContain("w-full");
    expect(AGENT_SPAWN_CTA_CLASS_NAME).toContain("rounded-md");
  });
});
