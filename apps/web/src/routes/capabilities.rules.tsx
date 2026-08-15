import { createFileRoute } from "@tanstack/react-router";

import { CapabilityItemsPanel } from "../components/capabilities/CapabilityItemsPanel";
import { validateCapabilitiesSearch } from "../components/capabilities/capabilitiesNav";

function CapabilitiesRulesRoute() {
  const search = Route.useSearch();
  return <CapabilityItemsPanel kind="rules" projectKey={search.projectKey ?? null} />;
}

export const Route = createFileRoute("/capabilities/rules")({
  validateSearch: validateCapabilitiesSearch,
  component: CapabilitiesRulesRoute,
});
