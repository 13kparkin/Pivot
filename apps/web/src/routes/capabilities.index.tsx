import { createFileRoute } from "@tanstack/react-router";

import { CapabilitiesOverviewPanel } from "../components/capabilities/CapabilitiesOverviewPanel";

function CapabilitiesOverviewRoute() {
  return <CapabilitiesOverviewPanel />;
}

export const Route = createFileRoute("/capabilities/")({
  component: CapabilitiesOverviewRoute,
});
