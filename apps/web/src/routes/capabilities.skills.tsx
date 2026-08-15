import { createFileRoute } from "@tanstack/react-router";

import { CapabilityItemsPanel } from "../components/capabilities/CapabilityItemsPanel";
import { validateCapabilitiesSearch } from "../components/capabilities/capabilitiesNav";

function CapabilitiesSkillsRoute() {
  const search = Route.useSearch();
  return <CapabilityItemsPanel kind="skills" projectKey={search.projectKey ?? null} />;
}

export const Route = createFileRoute("/capabilities/skills")({
  validateSearch: validateCapabilitiesSearch,
  component: CapabilitiesSkillsRoute,
});
