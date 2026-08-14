/**
 * Read omp `modelRoles.<role>` selectors from agent config.yml text.
 *
 * @module provider/omp/ompModelRoles
 */

import { parse as parseYaml } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the configured model slug for `role` (for example `openai/gpt-5`),
 * or `undefined` when the role is missing / empty.
 */
export function parseOmpModelRoleSlug(configText: string, role: string): string | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(configText);
  } catch {
    return undefined;
  }
  if (!isRecord(doc)) {
    return undefined;
  }
  const roles = doc.modelRoles;
  if (!isRecord(roles)) {
    return undefined;
  }
  const value = roles[role];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
