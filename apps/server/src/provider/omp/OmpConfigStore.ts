/**
 * Typed read/write for omp `agent/config.yml` under a resolved omp home.
 *
 * @module provider/omp/OmpConfigStore
 */

import type { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";

export const OMP_MODEL_ROLE_NAMES = [
  "default",
  "smol",
  "slow",
  "plan",
  "advisor",
  "task",
  "vision",
  "designer",
  "commit",
  "tiny",
] as const;

export type OmpModelRoleName = (typeof OMP_MODEL_ROLE_NAMES)[number];

export type OmpConfigStoreSnapshot = {
  readonly modelRoles: Partial<Record<OmpModelRoleName, string>>;
  readonly advisor?: { readonly enabled?: boolean };
  readonly memoryBackend?: string;
  readonly toolGates?: {
    readonly github?: boolean;
    readonly security_scan?: boolean;
  };
};

export type OmpConfigStorePatch = {
  readonly modelRoles?: Partial<Record<OmpModelRoleName, string>>;
  readonly advisor?: { readonly enabled?: boolean };
  readonly memoryBackend?: string;
  readonly toolGates?: {
    readonly github?: boolean;
    readonly security_scan?: boolean;
  };
  readonly compaction?: { readonly enabled?: boolean };
  readonly retry?: { readonly enabled?: boolean };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedString(
  doc: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = doc;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  if (typeof current !== "string") return undefined;
  const trimmed = current.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNestedBoolean(
  doc: Record<string, unknown>,
  path: readonly string[],
): boolean | undefined {
  let current: unknown = doc;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return typeof current === "boolean" ? current : undefined;
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value) && isRecord(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function patchToYamlDoc(patch: OmpConfigStorePatch): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  if (patch.modelRoles !== undefined) {
    doc.modelRoles = { ...patch.modelRoles };
  }
  if (patch.advisor?.enabled !== undefined) {
    doc.advisor = { enabled: patch.advisor.enabled };
  }
  if (patch.memoryBackend !== undefined) {
    doc.memory = { backend: patch.memoryBackend };
  }
  if (patch.toolGates?.github !== undefined) {
    doc.github = { enabled: patch.toolGates.github };
  }
  if (patch.toolGates?.security_scan !== undefined) {
    doc.security = { enabled: patch.toolGates.security_scan };
  }
  if (patch.compaction?.enabled !== undefined) {
    doc.compaction = { enabled: patch.compaction.enabled };
  }
  if (patch.retry?.enabled !== undefined) {
    doc.retry = { enabled: patch.retry.enabled };
  }
  return doc;
}

function parseSnapshot(doc: unknown): OmpConfigStoreSnapshot {
  if (!isRecord(doc)) {
    return { modelRoles: {} };
  }

  const modelRoles: Partial<Record<OmpModelRoleName, string>> = {};
  const roles = doc.modelRoles;
  if (isRecord(roles)) {
    for (const role of OMP_MODEL_ROLE_NAMES) {
      const value = roles[role];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          modelRoles[role] = trimmed;
        }
      }
    }
  }

  const advisorEnabled = readNestedBoolean(doc, ["advisor", "enabled"]);
  const memoryBackend =
    readNestedString(doc, ["memory", "backend"]) ??
    (typeof doc["memory.backend"] === "string"
      ? doc["memory.backend"].trim() || undefined
      : undefined);
  const githubEnabled =
    readNestedBoolean(doc, ["github", "enabled"]) ?? readNestedBoolean(doc, ["tools", "github"]);
  const securityScanEnabled =
    readNestedBoolean(doc, ["security", "enabled"]) ??
    readNestedBoolean(doc, ["tools", "security_scan"]);

  return {
    modelRoles,
    ...(advisorEnabled !== undefined ? { advisor: { enabled: advisorEnabled } } : {}),
    ...(memoryBackend !== undefined ? { memoryBackend } : {}),
    ...(githubEnabled !== undefined || securityScanEnabled !== undefined
      ? {
          toolGates: {
            ...(githubEnabled !== undefined ? { github: githubEnabled } : {}),
            ...(securityScanEnabled !== undefined ? { security_scan: securityScanEnabled } : {}),
          },
        }
      : {}),
  };
}

const ROLE_SETTING_KEYS = [
  ["default", "roleDefault"],
  ["smol", "roleSmol"],
  ["slow", "roleSlow"],
  ["plan", "rolePlan"],
  ["advisor", "roleAdvisor"],
  ["task", "roleTask"],
  ["vision", "roleVision"],
  ["designer", "roleDesigner"],
  ["commit", "roleCommit"],
  ["tiny", "roleTiny"],
] as const satisfies ReadonlyArray<readonly [OmpModelRoleName, keyof OmpSettings]>;

/**
 * Map Pivot `OmpSettings` fields into an omp config.yml patch and write it.
 */
export const syncOmpSettingsToConfigStore = (
  settings: OmpSettings,
  store: OmpConfigStore,
): Effect.Effect<void> => {
  const modelRoles: Partial<Record<OmpModelRoleName, string>> = {};
  for (const [role, key] of ROLE_SETTING_KEYS) {
    const value = settings[key];
    if (typeof value === "string" && value.trim().length > 0) {
      modelRoles[role] = value.trim();
    }
  }

  const memoryBackend = settings.memoryBackend.trim();
  // Only push enabled toggles / non-empty strings. Default false/"" must not
  // clobber the host omp config (omp's own defaults differ, e.g. retry.enabled).
  const patch: OmpConfigStorePatch = {
    modelRoles,
    ...(memoryBackend.length > 0 ? { memoryBackend } : {}),
    ...(settings.advisorEnabled ? { advisor: { enabled: true } } : {}),
    ...(settings.toolGithubEnabled || settings.toolSecurityScanEnabled
      ? {
          toolGates: {
            ...(settings.toolGithubEnabled ? { github: true } : {}),
            ...(settings.toolSecurityScanEnabled ? { security_scan: true } : {}),
          },
        }
      : {}),
    ...(settings.autoCompactionEnabled ? { compaction: { enabled: true } } : {}),
    ...(settings.autoRetryEnabled ? { retry: { enabled: true } } : {}),
  };

  return store.write(patch);
};

export class OmpConfigStore {
  public constructor(
    private readonly fileSystem: FileSystem.FileSystem,
    private readonly path: Path.Path,
    private readonly ompHome: string,
  ) {}

  private configPath(): string {
    return this.path.join(this.ompHome, "agent", "config.yml");
  }

  public read(): Effect.Effect<OmpConfigStoreSnapshot> {
    const fs = this.fileSystem;
    const configPath = this.configPath();
    return Effect.gen(function* () {
      const exists = yield* fs.exists(configPath);
      if (!exists) {
        return { modelRoles: {} } satisfies OmpConfigStoreSnapshot;
      }
      const text = yield* fs.readFileString(configPath);
      let doc: unknown;
      try {
        doc = parseYaml(text);
      } catch {
        return { modelRoles: {} } satisfies OmpConfigStoreSnapshot;
      }
      return parseSnapshot(doc);
    }).pipe(Effect.orElseSucceed(() => ({ modelRoles: {} }) satisfies OmpConfigStoreSnapshot));
  }

  public write(patch: OmpConfigStorePatch): Effect.Effect<void> {
    const fs = this.fileSystem;
    const pathService = this.path;
    const configPath = this.configPath();
    const yamlPatch = patchToYamlDoc(patch);

    return Effect.gen(function* () {
      let existing: Record<string, unknown> = {};
      const exists = yield* fs.exists(configPath);
      if (exists) {
        const text = yield* fs.readFileString(configPath);
        try {
          const parsed = parseYaml(text);
          if (isRecord(parsed)) {
            existing = parsed;
          }
        } catch {
          existing = {};
        }
      }

      const merged = deepMerge(existing, yamlPatch);
      const contents = stringifyYaml(merged);
      yield* writeFileStringAtomically({ filePath: configPath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    }).pipe(Effect.orDie);
  }
}
