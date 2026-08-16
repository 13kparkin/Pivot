import { createFileRoute } from "@tanstack/react-router";

import { CapabilitiesModelsRolesPanel } from "../components/capabilities/CapabilitiesModelsRolesPanel";
import { validateCapabilitiesSearch } from "../components/capabilities/capabilitiesNav";

function CapabilitiesModelsRolesRoute() {
  const search = Route.useSearch();
  return <CapabilitiesModelsRolesPanel projectKey={search.projectKey ?? null} />;
}

export const Route = createFileRoute("/capabilities/models-and-roles")({
  validateSearch: validateCapabilitiesSearch,
  component: CapabilitiesModelsRolesRoute,
});
