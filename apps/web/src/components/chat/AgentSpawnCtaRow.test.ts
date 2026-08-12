import { describe, expect, it } from "vite-plus/test";

import { AGENT_SPAWN_CTA_CLASS_NAME, AGENT_SPAWN_CTA_TRIGGER_CLASS_NAME } from "./MessagesTimeline";

describe("AgentSpawnCtaRow", () => {
  it("uses the changed-files card shell", () => {
    expect(AGENT_SPAWN_CTA_CLASS_NAME).toContain("rounded-2xl");
    expect(AGENT_SPAWN_CTA_CLASS_NAME).toContain("bg-secondary");
    expect(AGENT_SPAWN_CTA_CLASS_NAME).toContain("p-2");
  });

  it("keeps the trigger inside the card", () => {
    expect(AGENT_SPAWN_CTA_TRIGGER_CLASS_NAME).not.toContain("-mx-1");
    expect(AGENT_SPAWN_CTA_TRIGGER_CLASS_NAME).toContain("min-w-0");
    expect(AGENT_SPAWN_CTA_TRIGGER_CLASS_NAME).toContain("flex-1");
    expect(AGENT_SPAWN_CTA_TRIGGER_CLASS_NAME).toContain("rounded-lg");
  });
});
