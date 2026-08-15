import type { EnvironmentId, OmpCapabilityResource, ProjectId } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

/**
 * Resolve the project omp should operate on for the active environment.
 * An explicit `projectKey` (from the ?projectKey= capabilities search param)
 * picks that group's member in the active environment; without one the first
 * group member whose project lives in that environment wins, so the global
 * entry (/capabilities without ?projectKey=) behaves exactly as before.
 */
export function resolveCapabilitiesProjectId(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  environmentId: EnvironmentId | null,
  projectKey?: string | null,
): ProjectId | null {
  if (environmentId === null) return null;
  if (projectKey) {
    const group = groups.find((candidate) => candidate.projectKey === projectKey) ?? null;
    return (
      group?.memberProjects.find((member) => member.environmentId === environmentId)?.id ?? null
    );
  }
  for (const group of groups) {
    for (const member of group.memberProjects) {
      if (member.environmentId === environmentId) return member.id;
    }
  }
  return null;
}

/** Display order: broadest scope first. */
const SCOPE_ORDER: Readonly<Record<OmpCapabilityResource["scope"], number>> = {
  global: 0,
  project: 1,
  profile: 2,
};

export interface CapabilityRow {
  readonly resource: OmpCapabilityResource;
  readonly label: string;
  readonly scopeLabel: string;
  readonly provenanceLabel: string;
  readonly statusLabel: string;
}

function statusLabelFor(resource: OmpCapabilityResource): string {
  if (!resource.exists) return "missing";
  return resource.hasValue === true || resource.masked !== true ? "present" : "masked";
}

/**
 * Present the discovered capability resources in display order (scope, then
 * kind) with human-readable labels for the scope/provenance/status columns.
 */
export function buildCapabilityRows(
  resources: ReadonlyArray<OmpCapabilityResource>,
): ReadonlyArray<CapabilityRow> {
  return resources
    .map((resource) => ({
      resource,
      label: resource.name,
      scopeLabel:
        resource.scope === "global"
          ? "Global"
          : resource.scope === "project"
            ? "Project"
            : "Profile",
      provenanceLabel: resource.provenance,
      statusLabel: statusLabelFor(resource),
    }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.resource.scope] - SCOPE_ORDER[b.resource.scope] ||
        a.resource.kind.localeCompare(b.resource.kind),
    );
}
