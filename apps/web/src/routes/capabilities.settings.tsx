import { createFileRoute } from "@tanstack/react-router";

import { CapabilitiesSettingsPanel } from "../components/capabilities/CapabilitiesSettingsPanel";
import { validateCapabilitiesSearch } from "../components/capabilities/capabilitiesNav";

function CapabilitiesSettingsRoute() {
  const search = Route.useSearch();
  return <CapabilitiesSettingsPanel projectKey={search.projectKey ?? null} />;
}

export const Route = createFileRoute("/capabilities/settings")({
  validateSearch: validateCapabilitiesSearch,
  component: CapabilitiesSettingsRoute,
});
