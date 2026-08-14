import { createFileRoute } from "@tanstack/react-router";

import { CapabilityItemsPanel } from "../components/capabilities/CapabilityItemsPanel";

function CapabilitiesSkillsRoute() {
  return <CapabilityItemsPanel kind="skills" />;
}

export const Route = createFileRoute("/capabilities/skills")({
  component: CapabilitiesSkillsRoute,
});
