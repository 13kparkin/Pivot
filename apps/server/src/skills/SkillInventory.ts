import type {
  ProviderInstanceConfig,
  SkillInventory,
  SkillInventoryInstallation,
} from "@t3tools/contracts";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { discoverClaudeSkills } from "../provider/Drivers/ClaudeSkills.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

function harnessDisplayName(instance: ProviderInstanceConfig, fallback: string): string {
  return instance.displayName?.trim() || fallback;
}

const discoverInstanceSkills = Effect.fn("SkillInventory.discoverInstanceSkills")(function* (
  instanceId: string,
  instance: ProviderInstanceConfig,
): Effect.fn.Return<
  ReadonlyArray<SkillInventoryInstallation>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = instance.config ?? {};

  if (instance.driver === "codex") {
    const decoded = decodeCodexSettings(config);
    if (decoded._tag === "None") return [];
    const layout = yield* resolveCodexHomeLayout(decoded.value);
    const skills = yield* discoverClaudeSkills({ homePath: layout.sharedHomePath }, undefined, {});
    return yield* Effect.forEach(skills, (skill) =>
      fileSystem.readFileString(skill.path).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((content) => ({
          providerInstanceId: ProviderInstanceId.make(instanceId),
          harness: instance.driver,
          harnessDisplayName: harnessDisplayName(instance, "Codex"),
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          directoryPath: path.dirname(skill.path),
          skillFilePath: skill.path,
          content,
          enabled: skill.enabled,
        })),
      ),
    );
  }

  if (instance.driver === "claudeAgent") {
    const decoded = decodeClaudeSettings(config);
    if (decoded._tag === "None") return [];
    const skills = yield* discoverClaudeSkills(decoded.value, undefined);
    return yield* Effect.forEach(skills, (skill) =>
      fileSystem.readFileString(skill.path).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((content) => ({
          providerInstanceId: ProviderInstanceId.make(instanceId),
          harness: instance.driver,
          harnessDisplayName: harnessDisplayName(instance, "Claude"),
          name: skill.name,
          ...(skill.description ? { description: skill.description } : {}),
          directoryPath: path.dirname(skill.path),
          skillFilePath: skill.path,
          content,
          enabled: skill.enabled,
        })),
      ),
    );
  }

  return [];
});

export const discoverGlobalSkillInventory = Effect.fn(
  "SkillInventory.discoverGlobalSkillInventory",
)(function* (): Effect.fn.Return<
  SkillInventory,
  never,
  FileSystem.FileSystem | Path.Path | ServerSettingsService
> {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
  const providerInstances = deriveProviderInstanceConfigMap(settings);
  const installations = yield* Effect.forEach(
    Object.entries(providerInstances),
    ([instanceId, instance]) => discoverInstanceSkills(instanceId, instance),
    { concurrency: "unbounded" },
  );

  return {
    scannedAt: DateTime.formatIso(yield* DateTime.now),
    installations: installations
      .flat()
      .sort(
        (left, right) =>
          left.harnessDisplayName.localeCompare(right.harnessDisplayName) ||
          left.name.localeCompare(right.name),
      ),
  };
});
