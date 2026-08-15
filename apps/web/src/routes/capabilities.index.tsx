import { createFileRoute } from "@tanstack/react-router";

import { CapabilitiesOverviewPanel } from "../components/capabilities/CapabilitiesOverviewPanel";
import { validateCapabilitiesSearch } from "../components/capabilities/capabilitiesNav";

function CapabilitiesOverviewRoute() {
  const search = Route.useSearch();
  return <CapabilitiesOverviewPanel projectKey={search.projectKey ?? null} />;
}

export const Route = createFileRoute("/capabilities/")({
  validateSearch: validateCapabilitiesSearch,
  component: CapabilitiesOverviewRoute,
});
