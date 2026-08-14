import { createFileRoute } from "@tanstack/react-router";

import { CapabilityItemsPanel } from "../components/capabilities/CapabilityItemsPanel";

function CapabilitiesRulesRoute() {
  return <CapabilityItemsPanel kind="rules" />;
}

export const Route = createFileRoute("/capabilities/rules")({
  component: CapabilitiesRulesRoute,
});
