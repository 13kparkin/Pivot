import type { OmpSettingsSurfaceEntry } from "@t3tools/contracts";

/**
 * The omp `modelRoles` record as a flat `{ role: modelSlug }` map.
 *
 * The capabilities surface can represent it two ways:
 * - the global view keeps it as one `modelRoles` entry whose `value` is the
 *   whole record;
 * - the project view flattens it into `modelRoles.<role>` scalar entries.
 * Either shape is normalized to the same map.
 */
export function modelRolesFromSettingsEntries(
  entries: ReadonlyArray<OmpSettingsSurfaceEntry>,
): Readonly<Record<string, string>> {
  const roles: Record<string, string> = {};

  const recordEntry = entries.find((entry) => entry.key === "modelRoles");
  if (recordEntry !== undefined && isRecordValue(recordEntry.value)) {
    for (const [role, value] of Object.entries(recordEntry.value)) {
      if (typeof value === "string" && value.trim().length > 0) {
        roles[role] = value.trim();
      }
    }
    return roles;
  }

  const prefix = "modelRoles.";
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix)) continue;
    const role = entry.key.slice(prefix.length);
    if (role.length === 0 || typeof entry.value !== "string" || entry.value.trim().length === 0) {
      continue;
    }
    roles[role] = entry.value.trim();
  }

  return roles;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
