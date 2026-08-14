import { createFileRoute } from "@tanstack/react-router";

import { CapabilitiesSettingsPanel } from "../components/capabilities/CapabilitiesSettingsPanel";

function CapabilitiesSettingsRoute() {
  return <CapabilitiesSettingsPanel />;
}

export const Route = createFileRoute("/capabilities/settings")({
  component: CapabilitiesSettingsRoute,
});
